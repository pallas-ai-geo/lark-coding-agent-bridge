import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import {
  scopeForParts,
  scopeThreadIdForMessage,
} from '../../../src/bot/scope';

describe('IM scope rules', () => {
  it('keeps p2p on the chat scope and isolates every new group message', () => {
    expect(scopeThreadIdForMessage(message(), 'p2p')).toBeUndefined();
    expect(scopeThreadIdForMessage(message({ chatType: 'p2p' }), 'group')).toBeUndefined();
    expect(scopeThreadIdForMessage(message(), 'group')).toBe('om_msg');
    expect(scopeForParts('oc_group', scopeThreadIdForMessage(message(), 'group'))).toBe('oc_group:om_msg');
    expect(scopeThreadIdForMessage(message({ messageId: 'om_other', senderId: 'ou_other' }), 'group')).toBe('om_other');
    expect(scopeForParts('oc_group', undefined)).toBe('oc_group');
  });

  it('splits regular group reply threads by their stable root anchor', () => {
    const msg = message({
      rootId: 'om_root',
      parentId: 'om_parent',
      replyToMessageId: 'om_parent',
    });

    expect(scopeThreadIdForMessage(msg, 'group')).toBe('om_root');
    expect(scopeForParts('oc_group', scopeThreadIdForMessage(msg, 'group'))).toBe(
      'oc_group:om_root',
    );
  });

  it('keeps topic groups scoped by Feishu thread id', () => {
    const msg = message({
      threadId: 'omt_topic',
      rootId: 'om_root',
      parentId: 'om_parent',
    });

    expect(scopeThreadIdForMessage(msg, 'topic')).toBe('om_root');
    expect(scopeForParts('oc_group', scopeThreadIdForMessage(msg, 'topic'))).toBe(
      'oc_group:om_root',
    );
  });

  it('retains the original root when a group reply starts carrying an omt ID', () => {
    const root = message({ messageId: 'om_root' });
    const reply = message({ messageId: 'om_reply', rootId: 'om_root', parentId: 'om_bot_reply', threadId: 'omt_new' });
    expect(scopeThreadIdForMessage(root, 'group')).toBe(scopeThreadIdForMessage(reply, 'topic'));
  });

  it('never falls back to a group-wide session for malformed group events', () => {
    expect(() => scopeThreadIdForMessage(message({ messageId: undefined }), 'group')).toThrow('anchor');
    expect(scopeThreadIdForMessage(message({ threadId: 'omt_only' }), 'topic')).toBe('omt_only');
  });
});

function message(
  overrides: Record<string, unknown> = {},
): NormalizedMessage {
  return {
    messageId: 'om_msg',
    chatId: 'oc_group',
    chatType: 'group',
    senderId: 'ou_user',
    content: 'hi',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1000,
    ...overrides,
  } as unknown as NormalizedMessage;
}
