import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { ChatModeCache } from '../bot/chat-mode-cache';
import type { PendingQueue } from '../bot/pending-queue';
import type { ProcessPool } from '../bot/process-pool';
import type { CallbackAuth } from './callback-auth';
import { runCommandHandler, type CommandContext, type Controls } from '../commands';
import { log } from '../core/logger';
import { canUseDm, canUseGroup } from '../policy/access';
import type { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { commandSessionCatalogIdentity } from '../bot/session-catalog-identity';
import {
  scopeForParts,
  scopeThreadIdForIds,
  type ScopeMessageIds,
} from '../bot/scope';

/** Marker key on a button's value object that flags the cardAction as
 * a callback that should be forwarded back to the agent instead
 * of dispatched to a built-in command handler. The double-underscore
 * sigils make it virtually impossible to collide with normal payload
 * fields the agent might set.
 */
const BRIDGE_CALLBACK_MARKER = '__bridge_cb';
const LEGACY_CLAUDE_CALLBACK_MARKER = '__claude_cb';
const CARD_ACTION_SETTLE_MS = 300;

export interface CardDispatchDeps {
  channel: LarkChannel;
  evt: CardActionEvent;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: AgentAdapter;
  processPool?: ProcessPool;
  runExecutor?: RunExecutor;
  controls: Controls;
  pending: PendingQueue;
  chatModeCache: ChatModeCache;
  callbackAuth?: CallbackAuth;
  callbackPolicyFingerprint?: string;
  callbackPolicyFingerprintForScope?: (scope: string) => string | undefined;
}

export async function handleCardAction(deps: CardDispatchDeps): Promise<void> {
  const value = deps.evt.action.value;
  if (!value || typeof value !== 'object') return;
  const payload = value as Record<string, unknown>;

  const operatorId = deps.evt.operator.openId;
  const chatId = deps.evt.chatId;

  // CardKit 2.0 form submits drop user-input values from action.value; they
  // arrive on raw.action.form_value. The SDK forwards the raw event when
  // includeRawEvent: true is set on the channel options.
  const raw = (deps.evt as CardActionEvent & { raw?: unknown }).raw as
    | { action?: { form_value?: Record<string, unknown> } }
    | undefined;
  const formValue = raw?.action?.form_value;

  // Resolve the click's session scope. Topic groups need `thread_id`; regular
  // group reply threads may only carry `root_id` / `parent_id`. Look up the
  // carrier message (the card lives on it) once so callbacks target the same
  // scope that created the card.
  // Done before the access check so we know the chat mode (p2p vs group)
  // and can skip the chat allowlist for DMs.
  const { scope, threadId, mode, ids } = await resolveScope(deps);

  const accessDecision =
    mode === 'p2p'
      ? canUseDm(deps.controls.profileConfig, deps.controls, operatorId)
      : canUseGroup(deps.controls.profileConfig, deps.controls, chatId, operatorId);
  if (!accessDecision.ok) {
    log.info('cardAction', 'skip-not-allowed-user', {
      operator: operatorId.slice(-6),
      reason: accessDecision.reason,
    });
    return;
  }

  if (LEGACY_CLAUDE_CALLBACK_MARKER in payload) {
    log.info('cardAction', 'skip-legacy-callback-marker', { scope });
    return;
  }

  if (isApprovalTestPayload(payload)) {
    await handleApprovalTestAction(
      deps,
      payload,
      formValue,
      accessDecision.reason,
      scope,
      threadId,
      mode,
      ids,
    );
    return;
  }

  const cmd = typeof payload.cmd === 'string' ? payload.cmd : '';
  if (cmd) {
    if (isSignedBridgeCallback(payload) && !verifyBridgeToken(deps, payload, scope, cmd)) {
      return;
    }
    log.info('cardAction', 'cmd', { cmd, scope });
    const msg = makeFakeMsg(deps.evt, threadId, ids);

    const ctx: CommandContext = {
      channel: deps.channel,
      msg,
      scope,
      chatMode: mode,
      sessions: deps.sessions,
      sessionCatalog: deps.sessionCatalog,
      sessionCatalogIdentity: await commandSessionCatalogIdentity({
        msg,
        scope,
        mode,
        workspaces: deps.workspaces,
        controls: deps.controls,
        access: accessDecision,
      }),
      workspaces: deps.workspaces,
      activeRuns: deps.activeRuns,
      agent: deps.agent,
      processPool: deps.processPool,
      runExecutor: deps.runExecutor,
      controls: deps.controls,
      formValue,
      fromCardAction: true,
    };

    const [name, ...rest] = cmd.split('.');
    const sub = rest.join(' ');
    const args = composeArgs(sub, payload);

    try {
      const ok = await runCommandHandler(name ?? '', args, ctx);
      if (!ok) log.warn('cardAction', 'unknown', { cmd });
    } catch (err) {
      log.fail('cardAction', err, { cmd });
    }
    return;
  }

  // Agent-driven callback: the button was rendered by an agent via lark-cli,
  // with `__bridge_cb` set on the value. Forward the click back into the
  // scope's pending queue so the agent resumes its session and sees the click
  // as a follow-up message, with full context of what it sent.
  if (BRIDGE_CALLBACK_MARKER in payload) {
    if (!verifyBridgeToken(deps, payload, scope, 'agent_callback')) return;
    forwardToAgent(deps, payload, formValue, scope, threadId, mode, ids);
    return;
  }

  return;
}

async function handleApprovalTestAction(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  formValue: Record<string, unknown> | undefined,
  accessReason: string,
  scope: string,
  threadId: string | undefined,
  mode: 'p2p' | 'group' | 'topic',
  ids: ScopeMessageIds,
): Promise<void> {
  const decision = approvalDecision(payload.decision);
  const approverOpenIds = stringArray(payload.approver_open_ids);
  const operatorId = deps.evt.operator.openId;
  const operatorName = deps.evt.operator.name || operatorId;
  const comment = formString(formValue, 'approval_comment');
  const allowed =
    approverOpenIds.includes(operatorId) ||
    accessReason === 'owner' ||
    accessReason === 'allowed-admin';

  log.info('cardAction', 'approval-test', {
    decision,
    allowed,
    operator: operatorId.slice(-6),
    accessReason,
    messageId: deps.evt.messageId,
  });

  if (!allowed) {
    await safeSend(
      deps,
      operatorId,
      `审批测试：你没有权限操作这张卡片。\n\n你的 open_id：\`${operatorId}\``,
    );
    return;
  }

  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const status =
    decision === 'approve' ? '已通过' : decision === 'reject' ? '已驳回' : '已记录意见';
  const color = decision === 'approve' ? 'green' : decision === 'reject' ? 'red' : 'blue';
  const nextCard = approvalTestResultCard({
    status,
    color,
    operatorName,
    operatorId,
    decidedAt: now,
    requestId: typeof payload.request_id === 'string' ? payload.request_id : 'native-callback-test',
    comment,
  });

  const channel = deps.channel;
  const messageId = deps.evt.messageId;
  enqueueApprovalStatus(deps, {
    scope,
    threadId,
    mode,
    ids,
    decision,
    status,
    operatorId,
    operatorName,
    requestId: typeof payload.request_id === 'string' ? payload.request_id : 'native-callback-test',
    comment,
  });
  void (async () => {
    await delay(CARD_ACTION_SETTLE_MS);
    try {
      await channel.updateCard(messageId, nextCard);
    } catch (err) {
      log.fail('cardAction', err, { step: 'approval-test-update' });
      await safeSend(
        deps,
        operatorId,
        `审批测试：已收到你的${approvalActionLabel(decision)}，但更新卡片失败。`,
      );
    }
  })();
}

function enqueueApprovalStatus(
  deps: CardDispatchDeps,
  input: {
    scope: string;
    threadId: string | undefined;
    mode: 'p2p' | 'group' | 'topic';
    ids: ScopeMessageIds;
    decision: ApprovalDecision;
    status: string;
    operatorId: string;
    operatorName: string;
    requestId: string;
    comment: string;
  },
): void {
  const actionText =
    input.decision === 'approve'
      ? '继续处理该需求'
      : input.decision === 'reject'
        ? '不要继续处理该需求'
        : '参考审批意见继续判断';
  const synthetic: NormalizedMessage = {
    messageId: deps.evt.messageId,
    chatId: deps.evt.chatId,
    chatType: input.mode === 'p2p' ? 'p2p' : 'group',
    threadId: input.threadId,
    rootId: input.ids.rootId,
    senderId: input.operatorId,
    senderName: input.operatorName,
    content: [
      '[approval-status]',
      `审批状态：${input.status}`,
      `审批动作：${input.decision}`,
      `请求：${input.requestId}`,
      `审批卡片：${deps.evt.messageId}`,
      `审批人：${input.operatorName} (${input.operatorId})`,
      ...(input.comment ? [`审批意见：${input.comment}`] : []),
      `请根据审批结果${actionText}。`,
    ].join('\n'),
    rawContentType: 'approval_status',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
  };
  const queueSize = deps.pending.push(input.scope, synthetic);
  log.info('cardAction', 'approval-status-queued', {
    scope: input.scope,
    queueSize,
    decision: input.decision,
    requestId: input.requestId,
  });
}

type ApprovalDecision = 'approve' | 'reject' | 'comment';

function approvalDecision(value: unknown): ApprovalDecision {
  if (value === 'approve' || value === 'reject' || value === 'comment') return value;
  return 'reject';
}

function approvalActionLabel(decision: ApprovalDecision): string {
  return decision === 'approve' ? '通过' : decision === 'reject' ? '驳回' : '意见';
}

function isApprovalTestPayload(payload: Record<string, unknown>): boolean {
  return payload.bridge_action === 'approval_test';
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function formString(formValue: Record<string, unknown> | undefined, key: string): string {
  const value = formValue?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

async function safeSend(deps: CardDispatchDeps, to: string, markdown: string): Promise<void> {
  try {
    await deps.channel.send(to, { markdown });
  } catch (err) {
    log.fail('cardAction', err, { step: 'approval-test-feedback' });
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function approvalTestResultCard(input: {
  status: string;
  color: string;
  operatorName: string;
  operatorId: string;
  decidedAt: string;
  requestId: string;
  comment: string;
}): object {
  const statusIcon = input.color === 'green' ? '✅' : input.color === 'red' ? '❌' : '📝';
  return {
    schema: '2.0',
    config: {
      summary: { content: `审批测试：${input.status}` },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            `${statusIcon} **审批测试：${input.status}**`,
            '',
            `**状态**：${input.status}`,
            `**操作人**：${escapeCardMd(input.operatorName)}（\`${escapeCode(input.operatorId)}\`）`,
            `**时间**：${escapeCardMd(input.decidedAt)}`,
            `**请求**：\`${escapeCode(input.requestId)}\``,
            ...(input.comment ? [`**意见**：${escapeCardMd(input.comment)}`] : []),
          ].join('\n'),
        },
      ],
    },
  };
}

function escapeCardMd(value: string): string {
  return value.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(value: string): string {
  return value.replace(/`/g, "'");
}

async function resolveScope(
  deps: CardDispatchDeps,
): Promise<{
  scope: string;
  threadId: string | undefined;
  mode: 'p2p' | 'group' | 'topic';
  ids: ScopeMessageIds;
}> {
  const chatId = deps.evt.chatId;
  const mode = await deps.chatModeCache.resolve(deps.channel, chatId);
  if (mode === 'p2p') {
    return { scope: chatId, threadId: undefined, mode, ids: { messageId: deps.evt.messageId } };
  }

  // One API call per click; could cache by messageId if it ever becomes hot.
  const ids = await lookupMessageScopeIds(deps.channel, deps.evt.messageId);
  const threadId = scopeThreadIdForIds(ids, mode);
  return { scope: scopeForParts(chatId, threadId), threadId, mode, ids };
}

async function lookupMessageScopeIds(
  channel: LarkChannel,
  messageId: string,
): Promise<ScopeMessageIds> {
  try {
    // fetchRawMessage returns the raw `im.v1.message.get` items, which carry
    // thread/root metadata. We intentionally avoid channel.fetchMessage()
    // here: its NormalizedMessage path rebuilds a synthetic raw event without
    // `thread_id`, so scoped card clicks would fall back to the plain chatId.
    const [parent] = await channel.fetchRawMessage(messageId);
    const raw = parent as
      | {
          thread_id?: string;
          root_id?: string;
          parent_id?: string;
        }
      | undefined;
    return {
      messageId,
      ...(raw?.thread_id ? { threadId: raw.thread_id } : {}),
      ...(raw?.root_id ? { rootId: raw.root_id } : {}),
      ...(raw?.parent_id ? { parentId: raw.parent_id } : {}),
    };
  } catch (err) {
    log.warn('cardAction', 'scope-ids-lookup-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { messageId };
  }
}

function forwardToAgent(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  formValue: Record<string, unknown> | undefined,
  scope: string,
  threadId: string | undefined,
  mode: 'p2p' | 'group' | 'topic',
  ids: ScopeMessageIds = {},
): void {
  // Strip the marker so the agent only sees the meaningful fields it set.
  const {
    [BRIDGE_CALLBACK_MARKER]: _marker,
    bridge_token: _token,
    ...agentPayload
  } = payload;
  const merged = formValue ? { ...agentPayload, form_value: formValue } : agentPayload;
  log.info('cardAction', 'forward-agent', {
    scope,
    payload: JSON.stringify(merged).slice(0, 200),
  });
  const synthetic: NormalizedMessage = {
    messageId: deps.evt.messageId,
    chatId: deps.evt.chatId,
    chatType: mode === 'p2p' ? 'p2p' : 'group',
    threadId,
    rootId: ids.rootId,
    senderId: deps.evt.operator.openId,
    senderName: deps.evt.operator.name,
    content: `[card-click] ${JSON.stringify(merged)}`,
    rawContentType: 'card_action',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
  deps.pending.push(scope, synthetic);
}

function verifyBridgeToken(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  scope: string,
  action: string,
): boolean {
  const token = typeof payload.bridge_token === 'string' ? payload.bridge_token : '';
  const active = deps.activeRuns.get(scope);
  if (!deps.callbackAuth || !token || !active) {
    log.info('cardAction', 'skip-callback-auth-missing', { scope, action });
    log.warn('callback', 'denied', { scope, action, reason: 'missing-token-or-run' });
    return false;
  }
  const result = deps.callbackAuth.verify(token, {
    runId: active.run.runId,
    scope,
    chatId: deps.evt.chatId,
    operatorOpenId: deps.evt.operator.openId,
    action,
    policyFingerprint:
      deps.callbackPolicyFingerprintForScope?.(scope) ??
      deps.callbackPolicyFingerprint ??
      '',
  });
  if (!result.ok) {
    log.info('cardAction', 'skip-callback-auth-failed', {
      scope,
      action,
      reason: result.reason,
    });
    log.warn('callback', 'denied', { scope, action, reason: result.reason });
    return false;
  }
  return true;
}

function isSignedBridgeCallback(payload: Record<string, unknown>): boolean {
  return BRIDGE_CALLBACK_MARKER in payload || typeof payload.bridge_token === 'string';
}

/** Turn a button payload like {cmd:'ws.use', name:'proj-a'} into the arg
 * string the text-command handler expects: 'use proj-a'. Accepts `arg`
 * (preferred, generic) or `name` (legacy ws cards). */
function composeArgs(sub: string, payload: Record<string, unknown>): string {
  if (!sub) return '';
  const arg =
    (typeof payload.arg === 'string' && payload.arg) ||
    (typeof payload.name === 'string' && payload.name) ||
    '';
  return arg ? `${sub} ${arg}` : sub;
}

function makeFakeMsg(
  evt: CardActionEvent,
  threadId: string | undefined,
  ids: ScopeMessageIds = {},
): NormalizedMessage {
  return {
    messageId: evt.messageId,
    chatId: evt.chatId,
    chatType: 'p2p',
    threadId,
    rootId: ids.rootId,
    senderId: evt.operator.openId,
    senderName: evt.operator.name,
    content: '',
    rawContentType: 'interactive',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}
