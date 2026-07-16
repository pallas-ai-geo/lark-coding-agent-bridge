import { createLarkChannel } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';

describe('Lark channel threaded chunk sends', () => {
  it.each([
    ['markdown', { markdown: longBody() }],
    ['text', { text: longBody() }],
  ] as const)('keeps every long %s chunk inside the reply thread', async (_kind, input) => {
    const { channel, reply, create } = fakeChannel();

    await channel.send('oc_chat', input, {
      replyTo: 'om_parent',
      replyInThread: true,
    });

    expect(reply.mock.calls.length).toBeGreaterThan(1);
    expect(create).not.toHaveBeenCalled();
    for (const [index, [params]] of reply.mock.calls.entries()) {
      expect(params).toMatchObject({
        path: { message_id: index === 0 ? 'om_parent' : `om_reply_${index + 1}` },
        data: { reply_in_thread: true },
      });
    }
  });

  it('keeps every long anchored reply chunk chained to the previous chunk', async () => {
    const { channel, reply, create } = fakeChannel();

    await channel.send('oc_chat', { markdown: longBody() }, { replyTo: 'om_parent' });

    expect(reply.mock.calls.length).toBeGreaterThan(1);
    expect(create).not.toHaveBeenCalled();
    for (const [index, [params]] of reply.mock.calls.entries()) {
      expect(params).toMatchObject({
        path: { message_id: index === 0 ? 'om_parent' : `om_reply_${index + 1}` },
      });
      expect(params.data.reply_in_thread).toBeUndefined();
    }
  });

  it('keeps plain fresh send continuations as top-level messages', async () => {
    const { channel, reply, create } = fakeChannel();

    await channel.send('oc_chat', { markdown: longBody() });

    expect(reply).not.toHaveBeenCalled();
    expect(create.mock.calls.length).toBeGreaterThan(1);
  });
});

function fakeChannel() {
  const channel = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'secret',
    outbound: { textChunkLimit: 32 },
    logger: {
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  });
  const reply = vi.fn(async (_params: MessageReplyParams) => ({
    data: { message_id: `om_reply_${reply.mock.calls.length + 1}` },
  }));
  const create = vi.fn(async (_params: MessageCreateParams) => ({
    data: { message_id: `om_create_${create.mock.calls.length + 1}` },
  }));
  const messageApi = (channel.rawClient as never as {
    im: { v1: { message: { reply: typeof reply; create: typeof create } } };
  }).im.v1.message;
  messageApi.reply = reply;
  messageApi.create = create;
  return { channel, reply, create };
}

function longBody(): string {
  return Array.from({ length: 40 }, (_, index) => `line ${index} threaded chunk test`).join('\n');
}

interface MessageReplyParams {
  path: { message_id: string };
  data: { reply_in_thread?: boolean };
}

interface MessageCreateParams {
  params: { receive_id_type: string };
  data: object;
}
