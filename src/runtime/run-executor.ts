import { randomUUID } from 'node:crypto';
import { promptSection } from '../agent/prompt';
import type { AgentAdapter, AgentEvent, AgentRun } from '../agent/types';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { RunRejected, SpawnFailed } from './errors';
import type { RunCredentials, RunCredentialFactory } from './run-credentials';

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
}

export interface SubmitRunInput {
  authorize?: RunCredentialFactory;
  scopeId: string;
  policy: RunPolicyAllow;
  sessionId?: string;
  threadId?: string;
  model?: string;
  images?: readonly string[];
  stopGraceMs?: number;
  nowait?: boolean;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export interface RunExecution {
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  subscribe(): AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
}

const DEFAULT_POST_DONE_EXIT_GRACE_MS = 2000;

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;

  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const submittedAt = this.now();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    const release = input.nowait ? this.pool.tryAcquire() : await this.pool.acquire();
    if (!release) {
      releaseScope();
      throw new RunRejected('pool-full', 'process pool is full');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }

    const runId = this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const runOptions = {
      runId,
      prompt: input.policy.prompt,
      cwd: input.policy.cwdRealpath,
      sessionId: input.sessionId,
      threadId: input.threadId,
      model: input.model,
      images: input.images,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
    };
    let run: AgentRun;
    let credentials: RunCredentials | undefined;
    let revokePromise: Promise<void> | undefined;
    const revokeCredentials = (): Promise<void> => {
      revokePromise ??= (async () => { await credentials?.dispose(); })();
      return revokePromise;
    };
    try {
      await this.agent.prepareRun?.(runOptions);
      if (input.authorize) {
        try { credentials = await input.authorize(runId); }
        catch (error) {
          if (error instanceof RunRejected && error.code === 'message-authorization-denied') {
            log.warn('authorization', 'denied', { reason: error.message });
            throw error;
          }
          log.warn('authorization', 'denied', { reason: 'identity-issuance-failed' });
          throw new RunRejected('message-authorization-denied', '飞书消息身份校验或 JWT 签发失败');
        }
      }
    } catch (err) {
      release();
      releaseScope();
      await revokeCredentials();
      if (err instanceof RunRejected) throw err;
      if (err instanceof SpawnFailed) throw err;
      throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
    }
    if (this.activeRuns.newRunsPaused()) {
      await revokeCredentials();
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    if (input.policy.expiresAt <= this.now()) {
      await revokeCredentials(); release(); releaseScope();
      throw new RunRejected('policy-expired', 'run policy expired during message authorization');
    }
    try {
      const rawRun = this.agent.run({ ...runOptions,
        ...(credentials?.messageSender ? { prompt: `${promptSection('message_sender', credentials.messageSender)}\n\n${runOptions.prompt}` } : {}),
        ...(credentials ? { env: { ...credentials.env }, removeEnvKeys: credentials.removeEnvKeys } : {}) });
      // All stop paths (including cards/reconnect calling handle.run.stop directly) revoke first.
      run = credentials ? {
        runId: rawRun.runId,
        events: rawRun.events,
        stop: async () => { await revokeCredentials(); await rawRun.stop(); },
        waitForExit: timeoutMs => rawRun.waitForExit(timeoutMs),
      } : rawRun;
    } catch (err) {
      release();
      releaseScope();
      await revokeCredentials();
      throw new SpawnFailed('agent spawn failed', err);
    }
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? 'unknown',
      stage: input.observability?.stage ?? 'submit',
    };
    log.info('run', 'started', {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
    });

    let handle: RunHandle;
    const removeLostListener = credentials?.onLost(() => {
      void revokeCredentials().finally(() => run.stop()).catch(() => {});
    });
    try {
      handle = this.activeRuns.register(input.scopeId, run);
    } catch (err) {
      releaseScope();
      release();
      await run.stop().catch(() => {});
      removeLostListener?.();
      await revokeCredentials();
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    let cleaned = false;
    const cleanup = async (waitForExit: boolean): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      removeLostListener?.();
      await revokeCredentials();
      this.activeRuns.unregister(input.scopeId, run);
      release();
      if (waitForExit) {
        const exited = await run.waitForExit(this.postDoneExitGraceMs);
        if (!exited) {
          log.warn('run', 'post-done-exit-timeout', {
            ...dimensions,
            graceMs: this.postDoneExitGraceMs,
          });
          await run.stop().catch((err) => {
            log.warn('run', 'post-done-stop-failed', {
              ...dimensions,
              err: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    };
    const fanout = new EventFanout(observeRunEvents(run.events, {
      dimensions,
      startedAt,
      now: this.now,
    }), async () => {
      await cleanup(!handle.interrupted);
    });
    // Credential lifetime must not depend on a renderer subscribing successfully.
    if (credentials) fanout.start();

    return {
      runId,
      scopeId: input.scopeId,
      run,
      handle,
      subscribe: () => fanout.subscribe(),
      stop: async () => {
        handle.interrupted = true;
        await revokeCredentials();
        await run.stop();
        await run.waitForExit(this.postDoneExitGraceMs);
        await cleanup(false);
      },
    };
  }
}

function observeRunEvents(
  events: AsyncIterable<AgentEvent>,
  opts: {
    dimensions: Record<string, unknown>;
    startedAt: number;
    now: () => number;
  },
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      for await (const event of events) {
        if (event.type === 'done') {
          log.info('run', 'completed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
          });
          yield event;
          return;
        }
        if (event.type === 'error') {
          log.warn('run', 'failed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
            error: event.message,
          });
          yield event;
          return;
        }
        yield event;
      }
    },
  };
}

class EventFanout {
  private readonly source: AsyncIterable<AgentEvent>;
  private readonly onDone: () => Promise<void>;
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private started = false;
  private done = false;
  private error: unknown;

  constructor(source: AsyncIterable<AgentEvent>, onDone: () => Promise<void>) {
    this.source = source;
    this.onDone = onDone;
  }

  subscribe(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<AgentEvent>> => {
            this.start();
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            if (this.done) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              const wake = (): void => {
                this.waiters.delete(wake);
                resolve();
              };
              this.waiters.add(wake);
            });
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.source) {
        if (isTerminalEvent(event)) await this.onDone();
        this.buffer.push(event);
        this.wakeAll();
        if (isTerminalEvent(event)) break;
      }
    } catch (err) {
      this.error = err;
    } finally {
      await this.onDone();
      this.done = true;
      this.wakeAll();
    }
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}
