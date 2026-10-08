import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

/**
 * Recover a message's topic `thread_id` (omt_*) via the raw `im.v1.message.get`
 * API.
 *
 * Feishu delivers a sizable fraction of topic-group message events (and every
 * card-action carrier) without a `thread_id` on the event payload — notably the
 * message that starts a new topic. The bridge routes topic replies and isolates
 * per-topic session scope off `thread_id`, so a missing one makes the reply
 * escape into a brand-new topic and collapses the scope to the chat level.
 *
 * The raw `im.v1.message.get` items DO carry `thread_id` even when the event
 * dropped it. We deliberately avoid `channel.fetchMessage()`: its
 * NormalizedMessage path rebuilds a synthetic raw event without `thread_id`, so
 * threadId always comes back undefined.
 *
 * Missing metadata never requires falling back to a group-wide session.
 */
export async function lookupMessageThreadId(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  return (await lookupMessageThread(channel, messageId))?.threadId;
}

export async function lookupMessageThread(
  channel: LarkChannel,
  messageId: string,
): Promise<{ threadId?: string; rootId?: string } | undefined> {
  try {
    const [parent] = await channel.fetchRawMessage(messageId);
    if (!parent || parent.message_id !== messageId) return undefined;
    // The SDK type omits these fields although the raw API supplies them.
    const raw = parent as { thread_id?: string; root_id?: string; parent_id?: string; message_id: string };
    return { threadId: raw.thread_id, rootId: raw.root_id || (!raw.parent_id ? raw.message_id : undefined) };
  } catch (err) {
    log.warn('thread', 'thread-id-lookup-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
