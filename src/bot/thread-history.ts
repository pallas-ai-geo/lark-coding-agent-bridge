import type { ApiMessageItem, LarkChannel, RawMessageEvent } from '@larksuite/channel';
import { normalize } from '@larksuite/channel';
import type { BridgePromptThreadHistory, BridgePromptThreadMessage } from '../agent/prompt';
import { log } from '../core/logger';
import { expandInteractiveCard } from './interactive-card';
import type { ChatMode } from './chat-mode-cache';

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_MESSAGES = 40;
const DEFAULT_MAX_CHARS = 24_000;

export interface ThreadHistoryOptions {
  scope: string;
  chatId: string;
  threadId?: string;
  mode: ChatMode;
  beforeCreateTime?: number;
  excludeMessageIds?: Set<string>;
  maxPages?: number;
  maxMessages?: number;
  maxChars?: number;
}

interface RawHistoryMessageItem {
  message_id?: string;
  upper_message_id?: string;
  msg_type?: string;
  body?: {
    content?: string;
  };
  create_time?: string | number;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  chat_id?: string;
  deleted?: boolean;
  sender?: {
    id?: string;
    id_type?: string;
    sender_type?: string;
    sender_name?: string;
  };
  mentions?: Array<{
    key?: string;
    id?: string | { open_id?: string; user_id?: string; union_id?: string };
    id_type?: string;
    name?: string;
    tenant_key?: string;
  }>;
}

interface MessageListResponse {
  data?: {
    has_more?: boolean;
    page_token?: string;
    items?: RawHistoryMessageItem[];
  };
}

export async function fetchThreadHistory(
  channel: LarkChannel,
  opts: ThreadHistoryOptions,
): Promise<BridgePromptThreadHistory | undefined> {
  if (!opts.threadId || opts.mode === 'p2p') return undefined;

  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const maxMessages = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const exclude = opts.excludeMessageIds ?? new Set<string>();
  const matched: RawHistoryMessageItem[] = [];
  let pageToken: string | undefined;
  let truncated = false;

  try {
    for (let page = 0; page < maxPages; page++) {
      const response = await channel.rawClient.im.v1.message.list({
        params: {
          container_id_type: 'thread',
          container_id: opts.threadId,
          sort_type: 'ByCreateTimeAsc',
          page_size: DEFAULT_PAGE_SIZE,
          card_msg_content_type: 'user_card_content',
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }) as MessageListResponse;
      const items = response.data?.items ?? [];
      for (const item of items) {
        if (!item.message_id || exclude.has(item.message_id) || item.deleted) continue;
        if (!isBefore(item, opts.beforeCreateTime)) continue;
        if (!belongsToThread(item, opts)) continue;
        matched.push(item);
        if (matched.length >= maxMessages) {
          truncated = true;
          break;
        }
      }
      if (truncated || !response.data?.has_more) break;
      pageToken = response.data.page_token;
      if (!pageToken) break;
    }
  } catch (err) {
    log.warn('thread-history', 'fetch-failed', {
      scope: opts.scope,
      chatId: opts.chatId,
      mode: opts.mode,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }

  if (matched.length === 0) return undefined;

  const messages: BridgePromptThreadMessage[] = [];
  let charCount = 0;
  for (const item of matched) {
    const message = await normalizeHistoryMessage(channel, item);
    if (!message) continue;
    const nextChars = message.content.length;
    if (messages.length > 0 && charCount + nextChars > maxChars) {
      truncated = true;
      break;
    }
    charCount += nextChars;
    messages.push(message);
  }

  if (messages.length === 0) return undefined;
  return {
    scope: opts.scope,
    chatId: opts.chatId,
    threadId: opts.threadId,
    ...(truncated ? { truncated: true } : {}),
    messages,
  };
}

function belongsToThread(item: RawHistoryMessageItem, opts: ThreadHistoryOptions): boolean {
  const ids = [item.thread_id, item.root_id, item.parent_id, item.message_id].filter(Boolean);
  if (ids.length === 0) return true;
  return ids.includes(opts.threadId);
}

function isBefore(item: RawHistoryMessageItem, beforeCreateTime: number | undefined): boolean {
  if (!beforeCreateTime || !item.create_time) return true;
  const createMs = parseCreateMs(item.create_time);
  return createMs === 0 || createMs < beforeCreateTime;
}

async function normalizeHistoryMessage(
  channel: LarkChannel,
  item: RawHistoryMessageItem,
): Promise<BridgePromptThreadMessage | undefined> {
  if (!item.message_id) return undefined;
  const senderId = item.sender?.id ?? '';
  const senderName = item.sender?.sender_name;
  const createMs = item.create_time ? parseCreateMs(item.create_time) : 0;
  const raw: RawMessageEvent = {
    sender: {
      sender_id: senderId ? { open_id: senderId } : {},
      sender_type: item.sender?.sender_type,
    },
    message: {
      message_id: item.message_id,
      chat_id: item.chat_id ?? '',
      chat_type: 'group',
      message_type: item.msg_type ?? 'text',
      content: item.body?.content ?? '',
      create_time: item.create_time !== undefined ? String(item.create_time) : undefined,
      mentions: normalizeMentions(item.mentions),
      ...(item.root_id ? { root_id: item.root_id } : {}),
      ...(item.parent_id ? { parent_id: item.parent_id } : {}),
      ...(item.thread_id ? { thread_id: item.thread_id } : {}),
    },
  };

  try {
    const normalized = await normalize(raw, {
      botIdentity: channel.botIdentity ?? { openId: '', name: '' },
      stripBotMentions: false,
      resolveSenderName: senderName ? () => senderName : undefined,
      fetchSubMessages: async (messageId) => {
        try {
          return await channel.fetchRawMessage(messageId, {
            cardContentType: 'user_card_content',
          });
        } catch {
          return [];
        }
      },
    });
    return {
      messageId: item.message_id,
      senderId,
      ...(senderName || normalized.senderName ? { senderName: senderName ?? normalized.senderName } : {}),
      ...(senderTypeOf(item.sender?.sender_type) ? { senderType: senderTypeOf(item.sender?.sender_type) } : {}),
      ...(createMs ? { createdAt: new Date(createMs).toISOString() } : {}),
      rawContentType: item.msg_type ?? 'text',
      content: expandInteractiveCard(normalized.content, item.body?.content),
    };
  } catch (err) {
    log.warn('thread-history', 'normalize-failed', {
      messageId: item.message_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      messageId: item.message_id,
      senderId,
      ...(senderName ? { senderName } : {}),
      ...(senderTypeOf(item.sender?.sender_type) ? { senderType: senderTypeOf(item.sender?.sender_type) } : {}),
      ...(createMs ? { createdAt: new Date(createMs).toISOString() } : {}),
      rawContentType: item.msg_type ?? 'text',
      content: fallbackContent(item),
    };
  }
}

function normalizeMentions(mentions: RawHistoryMessageItem['mentions']): RawMessageEvent['message']['mentions'] {
  return mentions?.map((mention) => {
    const id = typeof mention.id === 'string'
      ? idObject(mention.id, mention.id_type)
      : mention.id ?? {};
    return {
      key: mention.key ?? '',
      id,
      ...(mention.name ? { name: mention.name } : {}),
      ...(mention.tenant_key ? { tenant_key: mention.tenant_key } : {}),
    };
  });
}

function idObject(id: string, idType: string | undefined): { open_id?: string; user_id?: string; union_id?: string } {
  if (idType === 'user_id') return { user_id: id };
  if (idType === 'union_id') return { union_id: id };
  return { open_id: id };
}

function senderTypeOf(value: string | undefined): 'user' | 'bot' | undefined {
  if (value === 'user') return 'user';
  if (value === 'app' || value === 'bot') return 'bot';
  return undefined;
}

function parseCreateMs(value: string | number): number {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 10_000_000_000 ? n * 1000 : n;
}

function fallbackContent(item: RawHistoryMessageItem): string {
  const raw = item.body?.content;
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; content?: unknown };
    if (typeof parsed.text === 'string') return parsed.text;
    if (typeof parsed.content === 'string') return parsed.content;
  } catch {
    // raw content is still better than dropping the message entirely
  }
  return raw;
}
