import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import {
  scopeForParts,
  scopeThreadIdForMessage,
} from '../../../src/bot/scope';

describe('IM scope rules', () => {
  it('keeps p2p and top-level group messages on the chat scope', () => {
    expect(scopeThreadIdForMessage(message(), 'p2p')).toBeUndefined();
    expect(scopeThreadIdForMessage(message(), 'group')).toBeUndefined();
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

    expect(scopeThreadIdForMessage(msg, 'topic')).toBe('omt_topic');
    expect(scopeForParts('oc_group', scopeThreadIdForMessage(msg, 'topic'))).toBe(
      'oc_group:omt_topic',
    );
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
