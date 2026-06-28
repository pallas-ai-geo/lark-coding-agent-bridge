import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { ChatMode } from './chat-mode-cache';
import type { ChatModeCache } from './chat-mode-cache';

export interface ResolvedMessageScope {
  scope: string;
  mode: ChatMode;
  threadId?: string;
}

export interface ScopeMessageIds {
  messageId?: string;
  threadId?: string;
  rootId?: string;
  parentId?: string;
  replyToMessageId?: string;
}

/**
 * Compute the **session scope** for a message.
 *
 *  - **p2p / top-level group messages**: scope = `chatId`.
 *  - **regular group reply threads**: scope = `${chatId}:${replyThreadId}`.
 *  - **topic group**: scope = `${chatId}:${threadId}`.
 *
 * Topic-group top-level messages (no threadId, rare) and regular group
 * messages without a reply/thread anchor fall back to `chatId`.
 *
 * Async because chat mode requires an API lookup (cached after first hit).
 * Callers typically await this once at intake/cardAction entry and pass
 * the resolved scope through.
 */
export async function scopeFor(
  channel: LarkChannel,
  chatId: string,
  threadId: string | undefined,
  cache: ChatModeCache,
): Promise<string> {
  const mode = await cache.resolve(channel, chatId);
  return scopeForParts(chatId, scopeThreadIdForIds({ threadId }, mode));
}

/** Convenience overload from a NormalizedMessage. */
export async function scopeForMessage(
  channel: LarkChannel,
  msg: NormalizedMessage,
  cache: ChatModeCache,
): Promise<string> {
  const { scope } = await resolveMessageScope(channel, msg, cache);
  return scope;
}

export async function resolveMessageScope(
  channel: LarkChannel,
  msg: NormalizedMessage,
  cache: ChatModeCache,
): Promise<ResolvedMessageScope> {
  const mode = await cache.resolve(channel, msg.chatId);
  const threadId = scopeThreadIdForMessage(msg, mode);
  return {
    scope: scopeForParts(msg.chatId, threadId),
    mode,
    ...(threadId ? { threadId } : {}),
  };
}

export function scopeForParts(chatId: string, threadId: string | undefined): string {
  return threadId ? `${chatId}:${threadId}` : chatId;
}

export function scopeThreadIdForMessage(
  msg: NormalizedMessage,
  mode: ChatMode,
): string | undefined {
  return scopeThreadIdForIds(msg as ScopeMessageIds, mode);
}

export function scopeThreadIdForIds(
  ids: ScopeMessageIds,
  mode: ChatMode,
): string | undefined {
  if (mode === 'p2p') return undefined;
  if (mode === 'topic') return cleanScopePart(ids.threadId);

  return firstScopePart(
    ids.threadId,
    ids.rootId,
    ids.replyToMessageId,
    ids.parentId,
  );
}

function firstScopePart(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const cleaned = cleanScopePart(value);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function cleanScopePart(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
