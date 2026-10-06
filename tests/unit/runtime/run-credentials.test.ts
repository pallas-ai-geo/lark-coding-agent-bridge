import { describe, expect, it, vi } from 'vitest';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import type { RunCredentials } from '../../../src/runtime/run-credentials';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import type { AgentRunOptions } from '../../../src/agent/types';

class RunningAgent extends FakeAgentAdapter {
  override run(options: AgentRunOptions) {
    const run = super.run(options);
    let finish!: () => void;
    const stopped = new Promise<void>(resolve => { finish = resolve; });
    Object.defineProperty(run, 'events', { value: {
      async *[Symbol.asyncIterator]() { await stopped; yield { type: 'done', terminationReason: 'interrupted' }; },
    } });
    const originalStop = run.stop.bind(run);
    run.stop = async () => { await originalStop(); finish(); };
    return run;
  }
}

const policy: RunPolicyAllow = { ok: true, prompt: 'test', requestedCwd: '/repo', cwdRealpath: '/repo',
  accessMode: 'read-only', sandbox: 'read-only', permissionMode: 'plan', access: { ok: true, reason: 'allowed-user' },
  attachments: [], policyFingerprint: 'test', expiresAt: 2000 };

function credentials(jwt: string) {
  let lostListener: (() => void) | undefined;
  const dispose = vi.fn(async () => {});
  const credential: RunCredentials = { env: { PALLAS_ADMIN_JWT: jwt }, removeEnvKeys: ['BRIDGE_ADMIN_SECRET'], dispose,
    onLost(listener) { lostListener = listener; return () => { lostListener = undefined; }; } };
  return { credential, dispose, lose: () => lostListener?.() };
}

describe('Message grant lifecycle', () => {
  it('revokes before delivering terminal events and uses a new snapshot when the same thread changes user', async () => {
    const agent = new FakeAgentAdapter({ events: [[{ type: 'done', terminationReason: 'normal' }], [{ type: 'done', terminationReason: 'normal' }]] });
    const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 1), activeRuns, now: () => 1000 });
    const alice = credentials('alice-jwt'), bob = credentials('bob-jwt');
    const first = await executor.submit({ scopeId: 'shared-thread', threadId: 'same-codex-thread', policy, authorize: async () => alice.credential });
    expect(agent.runOptions[0]?.env?.PALLAS_ADMIN_JWT).toBe('alice-jwt');
    for await (const event of first.subscribe()) {
      if (event.type === 'done') expect(alice.dispose).toHaveBeenCalledTimes(1);
    }
    const second = await executor.submit({ scopeId: 'shared-thread', threadId: 'same-codex-thread', policy, authorize: async () => bob.credential });
    expect(agent.runOptions[1]?.env?.PALLAS_ADMIN_JWT).toBe('bob-jwt');
    expect(agent.runOptions[0]?.env).not.toBe(agent.runOptions[1]?.env);
    for await (const _ of second.subscribe()) { /* Drain. */ }
    expect(bob.dispose).toHaveBeenCalledTimes(1);
  });
  it('does not spawn or hold a pool slot if independent authorization fails', async () => {
    const agent = new FakeAgentAdapter(); const pool = new ProcessPool(() => 1);
    const executor = new RunExecutor({ agent, pool, activeRuns: new ActiveRuns(), now: () => 1000 });
    await expect(executor.submit({ scopeId: 'scope', policy, authorize: async () => { throw new Error('denied'); } }))
      .rejects.toMatchObject({ code: 'message-authorization-denied' });
    expect(agent.runOptions).toHaveLength(0); expect(pool.snapshot().active).toBe(0);
  });
  it('revokes if spawn fails or the run is cancelled', async () => {
    const agent = new FakeAgentAdapter(); const original = agent.run.bind(agent);
    const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns(), now: () => 1000 });
    const failed = credentials('failed');
    agent.run = () => { throw new Error('spawn failed'); };
    await expect(executor.submit({ scopeId: 'scope', policy, authorize: async () => failed.credential })).rejects.toMatchObject({ code: 'agent-spawn-failed' });
    expect(failed.dispose).toHaveBeenCalledTimes(1);
    agent.run = original;
    const cancelled = credentials('cancelled');
    const execution = await executor.submit({ scopeId: 'scope', policy, authorize: async () => cancelled.credential });
    await execution.stop(); expect(cancelled.dispose).toHaveBeenCalledTimes(1);
  });
  it('stops a running agent when its lease is lost', async () => {
    const agent = new RunningAgent(); const lease = credentials('token');
    const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns(), now: () => 1000 });
    const execution = await executor.submit({ scopeId: 'scope', policy, authorize: async () => lease.credential });
    lease.lose(); await vi.waitFor(() => expect(agent.runs[0]?.stopped).toBe(true));
    await execution.stop(); expect(lease.dispose).toHaveBeenCalled();
  });
  it('revokes even when a card or reconnect stops the raw active-run handle', async () => {
    const agent = new RunningAgent(); const lease = credentials('token'); const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 1), activeRuns, now: () => 1000 });
    const execution = await executor.submit({ scopeId: 'scope', policy, authorize: async () => lease.credential });
    await activeRuns.get('scope')!.run.stop();
    expect(lease.dispose).toHaveBeenCalledTimes(1); expect(agent.runs[0]?.stopped).toBe(true);
    await execution.stop(); expect(lease.dispose).toHaveBeenCalledTimes(1);
  });
  it('revokes completed runs even when no renderer subscribes to the event stream', async () => {
    const agent = new FakeAgentAdapter({ events: [{ type: 'done', terminationReason: 'normal' }] });
    const lease = credentials('token');
    const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns(), now: () => 1000 });
    await executor.submit({ scopeId: 'scope', policy, authorize: async () => lease.credential });
    await vi.waitFor(() => expect(lease.dispose).toHaveBeenCalledTimes(1));
  });
});
