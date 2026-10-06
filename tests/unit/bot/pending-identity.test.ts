import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { PendingQueue } from '../../../src/bot/pending-queue';

afterEach(() => vi.useRealTimers());
const msg = (senderId: string, messageId: string) => ({ senderId, messageId }) as NormalizedMessage;

describe('Message identity in the pending queue', () => {
  it('never combines different senders and preserves message order across blocked runs', () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const queue = new PendingQueue(10, (scope, batch) => {
      batches.push(batch.map(message => message.messageId)); queue.block(scope);
    });
    queue.push('same-chat', msg('alice', 'a1'));
    queue.push('same-chat', msg('bob', 'b1'));
    queue.push('same-chat', msg('alice', 'a2'));
    vi.advanceTimersByTime(10);
    expect(batches).toEqual([['a1']]);
    queue.unblock('same-chat'); vi.advanceTimersByTime(10);
    expect(batches).toEqual([['a1'], ['b1']]);
    queue.unblock('same-chat'); vi.advanceTimersByTime(10);
    expect(batches).toEqual([['a1'], ['b1'], ['a2']]);
    queue.cancelAll();
  });
  it('uses one message per credential, even for consecutive messages from the same sender', () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const queue = new PendingQueue(10, (_scope, batch) => batches.push(batch.map(message => message.messageId)), () => 1);
    queue.push('same-chat', msg('alice', 'a1')); queue.push('same-chat', msg('alice', 'a2'));
    vi.advanceTimersByTime(20);
    expect(batches).toEqual([['a1'], ['a2']]); queue.cancelAll();
  });
});
