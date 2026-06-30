import type { CardActionEvent } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { CallbackAuth } from '../../../src/card/callback-auth.js';
import { CallbackNonceStore } from '../../../src/card/callback-store.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentRun } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('signed card callback dispatch', () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('runs built-in command callbacks only when the bridge token verifies', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: h.token('stop'),
    });

    expect(activeRun.stopped).toBe(true);

    const deniedRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', deniedRun);
    await h.dispatch({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: h.token('stop', { operatorOpenId: 'ou_other' }),
    });

    expect(deniedRun.stopped).toBe(false);
  });

  it('forwards signed bridge callbacks without leaking auth fields into the agent payload', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' });
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch(
      {
        __bridge_cb: true,
        bridge_token: h.token('agent_callback', { nonce: 'nonce-agent' }),
        choice: 'a',
      },
      { note: 'from form' },
    );

    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a","form_value":{"note":"from form"}}');
    expect(queued[0]?.chatType).toBe('group');
  });

  it('drops legacy Claude callback markers before command dispatch', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      __claude_cb: true,
      cmd: 'stop',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });

  it('scopes topic-group callbacks by the carrier message thread_id', async () => {
    const h = await createHarness({ chatMode: 'topic' });
    // The dispatcher must read items[0].thread_id from the raw message get to
    // compose the `${chatId}:${threadId}` scope. A regression here (e.g. using
    // channel.fetchMessage, whose normalized shape drops thread_id) would fall
    // back to the bare chatId and route the click into the wrong session.
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    h.activeRuns.register('oc_group:th_topic', h.agent.run({ runId: 'run-active', prompt: 'running' }));

    await h.dispatch({
      __bridge_cb: true,
      bridge_token: h.token('agent_callback', { nonce: 'nonce-topic', scope: 'oc_group:th_topic' }),
      choice: 'a',
    });

    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    const queued = h.pending.cancel('oc_group:th_topic');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a"}');
  });

  it('scopes regular group reply callbacks by the carrier message root_id', async () => {
    const h = await createHarness({ chatMode: 'group' });
    h.channel.rawRootIds.set('om_card', 'om_reply_root');
    h.channel.rawParentIds.set('om_card', 'om_reply_parent');
    h.activeRuns.register(
      'oc_group:om_reply_root',
      h.agent.run({ runId: 'run-active', prompt: 'running' }),
    );

    await h.dispatch({
      __bridge_cb: true,
      bridge_token: h.token('agent_callback', {
        nonce: 'nonce-group-thread',
        scope: 'oc_group:om_reply_root',
      }),
      choice: 'b',
    });

    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    const queued = h.pending.cancel('oc_group:om_reply_root');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"b"}');
    expect(queued[0]?.rootId).toBe('om_reply_root');
  });

  it('rejects bridge callbacks when callback auth is unavailable', async () => {
    const h = await createHarness({ callbackAuth: false });
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      __bridge_cb: true,
      choice: 'unsafe',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });

  it('updates the native approval test card for allowed approvers', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.dispatch({
      bridge_action: 'approval_test',
      decision: 'approve',
      request_id: 'req-native-test',
      approver_open_ids: ['ou_operator'],
    });

    expect(h.channel.sent).toHaveLength(0);
    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.messageId).toBe('om_card');
    expect(queued[0]?.rawContentType).toBe('approval_status');
    expect(queued[0]?.content).toContain('审批状态：已通过');
    expect(queued[0]?.content).toContain('req-native-test');
    await vi.advanceTimersByTimeAsync(300);
    const patch = h.channel.rawClient.requests.find((req) => req.method === 'im.v1.message.patch');
    expect(patch).toBeDefined();
    expect(JSON.stringify(patch?.params)).toContain('审批测试：已通过');
    expect(JSON.stringify(patch?.params)).toContain('req-native-test');
    vi.useRealTimers();
  });

  it('allows the owner to operate native approval test cards even when not listed', async () => {
    vi.useFakeTimers();
    const h = await createHarness({ botOwnerId: 'ou_operator' });

    await h.dispatch({
      bridge_action: 'approval_test',
      decision: 'approve',
      request_id: 'req-owner-native-test',
      approver_open_ids: ['ou_someone_else'],
    });

    expect(h.channel.sent).toHaveLength(0);
    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.messageId).toBe('om_card');
    expect(queued[0]?.rawContentType).toBe('approval_status');
    expect(queued[0]?.content).toContain('审批状态：已通过');
    expect(queued[0]?.content).toContain('req-owner-native-test');
    await vi.advanceTimersByTimeAsync(300);
    const patch = h.channel.rawClient.requests.find((req) => req.method === 'im.v1.message.patch');
    expect(patch).toBeDefined();
    expect(JSON.stringify(patch?.params)).toContain('审批测试：已通过');
    expect(JSON.stringify(patch?.params)).toContain('req-owner-native-test');
    vi.useRealTimers();
  });

  it('accepts comma separated native approval approver ids', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.dispatch({
      bridge_action: 'approval_test',
      decision: 'approve',
      request_id: 'req-native-csv-approvers',
      approver_open_ids: 'ou_operator,ou_admin',
    });

    expect(h.channel.sent).toHaveLength(0);
    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toContain('审批状态：已通过');
    expect(queued[0]?.content).toContain('req-native-csv-approvers');
    await vi.advanceTimersByTimeAsync(300);
    const patch = h.channel.rawClient.requests.find((req) => req.method === 'im.v1.message.patch');
    expect(patch).toBeDefined();
    vi.useRealTimers();
  });

  it('passes manual approval comments to the agent and result card', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.dispatch(
      {
        bridge_action: 'approval_test',
        decision: 'comment',
        request_id: 'req-comment-test',
        approver_open_ids: ['ou_operator'],
      },
      { approval_comment: '需要先补充复现步骤' },
    );

    expect(h.channel.sent).toHaveLength(0);
    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.messageId).toBe('om_card');
    expect(queued[0]?.rawContentType).toBe('approval_status');
    expect(queued[0]?.content).toContain('审批状态：已记录意见');
    expect(queued[0]?.content).toContain('审批动作：comment');
    expect(queued[0]?.content).toContain('审批意见：需要先补充复现步骤');
    await vi.advanceTimersByTimeAsync(300);
    const patch = h.channel.rawClient.requests.find((req) => req.method === 'im.v1.message.patch');
    expect(patch).toBeDefined();
    expect(JSON.stringify(patch?.params)).toContain('审批测试：已记录意见');
    expect(JSON.stringify(patch?.params)).toContain('需要先补充复现步骤');
    vi.useRealTimers();
  });

  it('sends private feedback and leaves the card unchanged for denied approvers', async () => {
    const h = await createHarness();

    await h.dispatch({
      bridge_action: 'approval_test',
      decision: 'reject',
      request_id: 'req-native-test',
      approver_open_ids: ['ou_admin'],
    });

    expect(h.channel.rawClient.requests.some((req) => req.method === 'im.v1.message.patch')).toBe(false);
    expect(h.channel.sent).toHaveLength(1);
    expect(h.channel.sent[0]?.chatId).toBe('ou_operator');
    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('没有权限');
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });
});

type Harness = {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: FakeAgentAdapter;
  controls: Controls;
  pending: PendingQueue;
  auth: CallbackAuth;
  dispatch(value: Record<string, unknown>, formValue?: Record<string, unknown>): Promise<void>;
  token(
    action: string,
    overrides?: { operatorOpenId?: string; nonce?: string; scope?: string },
  ): string;
};

async function createHarness(
  opts: { callbackAuth?: boolean; chatMode?: 'p2p' | 'group' | 'topic'; botOwnerId?: string } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile('callback-dispatch-test-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter();
  const pending = new PendingQueue(60_000, () => {});
  const store = new CallbackNonceStore(`${tmp.profile}/callback-nonces.json`);
  const controls = {
    profile: 'claude',
    profileConfig: createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access: { allowedChats: ['oc_group'] },
    }),
    botOwnerId: opts.botOwnerId ?? 'ou_owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.profile}/config.json`,
    cfg: createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access: { allowedChats: ['oc_group'] },
    }),
    processId: 'proc-1',
  } satisfies Controls;
  let nonce = 'nonce-stop';
  const auth = new CallbackAuth({
    keys: [{ version: 1, secret: 'secret-1' }],
    nonceStore: store,
    now: () => 1000,
    createNonce: () => nonce,
  });
  const chatModeCache = {
    resolve: async () => opts.chatMode ?? 'group',
  } as unknown as ChatModeCache;
  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), store.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    sessions,
    workspaces,
    activeRuns,
    agent,
    controls,
    pending,
    auth,
    token: (action, overrides = {}) => {
      nonce = overrides.nonce ?? `nonce-${action}`;
      return auth.sign({
        runId: 'run-active',
        scope: overrides.scope ?? 'oc_group',
        chatId: 'oc_group',
        operatorOpenId: overrides.operatorOpenId ?? 'ou_operator',
        action,
        policyFingerprint: 'fp-1',
        ttlMs: 60_000,
      });
    },
    dispatch: (value, formValue) =>
      handleCardAction({
        channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
        evt: cardEvent(value, formValue),
        sessions,
        workspaces,
        activeRuns,
        agent,
        controls,
        pending,
        chatModeCache,
        ...(opts.callbackAuth === false ? {} : { callbackAuth: auth }),
        callbackPolicyFingerprint: 'fp-1',
      }),
  };
}

function cardEvent(
  value: Record<string, unknown>,
  formValue?: Record<string, unknown>,
): CardActionEvent {
  return {
    action: { value },
    chatId: 'oc_group',
    messageId: 'om_card',
    operator: {
      openId: 'ou_operator',
      name: 'Operator',
    },
    raw: formValue ? { action: { form_value: formValue } } : undefined,
  } as unknown as CardActionEvent;
}
