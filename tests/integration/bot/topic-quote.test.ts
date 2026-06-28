import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  markdownContents: string[];
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    im: {
      v1: {
        message: {
          list: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  getAppInfo: ReturnType<typeof vi.fn>;
  listChats: ReturnType<typeof vi.fn>;
  fetchRawMessage: ReturnType<typeof vi.fn>;
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('topic message quote handling', () => {
  it('does not quote the topic root when a user directly mentions the bot inside the topic', async () => {
    const h = await createHarness();

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_direct_at',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_topic',
        content: '@Bridge 继续说一下',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions).toHaveLength(1);
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('"threadId":"omt_topic"');
    expect(prompt).not.toContain('<quoted_messages>');
    expect(prompt).not.toContain('topic root content');
    expect(h.channel.fetchRawMessage).not.toHaveBeenCalled();
  });

  it('keeps regular group reply quotes as quoted context', async () => {
    const h = await createHarness({
      chatMode: 'group',
      quotedMessages: {
        om_quote_target: 'regular quoted content',
      },
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_group_reply',
        rootId: 'om_quote_target',
        parentId: 'om_quote_target',
        content: '@Bridge 看这条',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('<quoted_messages>');
    expect(prompt).toContain('regular quoted content');
    expect(h.channel.fetchRawMessage).toHaveBeenCalledWith(
      'om_quote_target',
      expect.objectContaining({ cardContentType: 'user_card_content' }),
    );
  });

  it('keeps non-root reply quotes in topic chats', async () => {
    const h = await createHarness({
      quotedMessages: {
        om_topic_parent: 'topic parent content',
      },
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_topic_reply',
        rootId: 'om_topic_root',
        parentId: 'om_topic_parent',
        threadId: 'omt_topic',
        content: '@Bridge 看父消息',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('<quoted_messages>');
    expect(prompt).toContain('topic parent content');
    expect(h.channel.fetchRawMessage).toHaveBeenCalledWith(
      'om_topic_parent',
      expect.objectContaining({ cardContentType: 'user_card_content' }),
    );
  });

  it('injects current topic history without unrelated group messages', async () => {
    const h = await createHarness({
      historyMessages: [
        historyMessage({
          messageId: 'om_history_a',
          threadId: 'omt_topic',
          rootId: 'om_topic_root',
          senderId: 'ou_alice',
          senderName: 'Alice',
          text: '前面讨论 A',
          createTime: '1760000000000',
        }),
        historyMessage({
          messageId: 'om_noise',
          threadId: 'omt_other',
          rootId: 'om_other_root',
          senderId: 'ou_noise',
          senderName: 'Noise',
          text: '别的话题',
          createTime: '1760000000500',
        }),
        historyMessage({
          messageId: 'om_direct_at',
          threadId: 'omt_topic',
          rootId: 'om_topic_root',
          senderId: 'ou_user',
          senderName: 'User',
          text: '@Bridge 总结一下',
          createTime: '1760000001000',
        }),
      ],
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_direct_at',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_topic',
        content: '@Bridge 总结一下',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const history = readSection(h.agent.runOptions[0]?.prompt ?? '', 'thread_history') as {
      messages: Array<{ messageId: string; senderId: string; senderName?: string; content: string }>;
    };
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]).toMatchObject({
      messageId: 'om_history_a',
      senderId: 'ou_alice',
      senderName: 'Alice',
      content: '前面讨论 A',
    });
    expect(JSON.stringify(history)).not.toContain('别的话题');
    expect(h.channel.rawClient.im.v1.message.list).toHaveBeenCalledWith({
      params: expect.objectContaining({
        container_id_type: 'thread',
        container_id: 'omt_topic',
        page_size: 50,
      }),
    });
  });

  it('caps injected topic history to forty messages', async () => {
    const h = await createHarness({
      historyMessages: Array.from({ length: 42 }, (_, index) =>
        historyMessage({
          messageId: `om_history_${index + 1}`,
          threadId: 'omt_topic',
          rootId: 'om_topic_root',
          senderId: `ou_user_${index + 1}`,
          senderName: `User ${index + 1}`,
          text: `历史 ${index + 1}`,
          createTime: String(1760000000000 + index),
        }),
      ),
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_direct_at',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_topic',
        content: '@Bridge 总结一下',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const history = readSection(h.agent.runOptions[0]?.prompt ?? '', 'thread_history') as {
      truncated?: boolean;
      messages: Array<{ messageId: string; content: string }>;
    };
    expect(history.truncated).toBe(true);
    expect(history.messages).toHaveLength(40);
    expect(history.messages[0]?.messageId).toBe('om_history_1');
    expect(history.messages[39]?.messageId).toBe('om_history_40');
    expect(JSON.stringify(history)).not.toContain('历史 41');
  });

  it('fetches regular group reply history from the thread container', async () => {
    const h = await createHarness({
      chatMode: 'group',
      historyMessages: [
        historyMessage({
          messageId: 'om_group_history',
          threadId: 'om_quote_target',
          rootId: 'om_quote_target',
          senderId: 'ou_alice',
          senderName: 'Alice',
          text: '普通群回复串里的历史',
          createTime: '1760000000000',
        }),
      ],
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_group_reply',
        rootId: 'om_quote_target',
        parentId: 'om_quote_target',
        content: '@Bridge 看这条',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const history = readSection(h.agent.runOptions[0]?.prompt ?? '', 'thread_history') as {
      messages: Array<{ messageId: string; content: string }>;
    };
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]).toMatchObject({
      messageId: 'om_group_history',
      content: '普通群回复串里的历史',
    });
    expect(h.channel.rawClient.im.v1.message.list).toHaveBeenCalledWith({
      params: expect.objectContaining({
        container_id_type: 'thread',
        container_id: 'om_quote_target',
        page_size: 50,
      }),
    });
  });

  it('mentions the triggering user only after the final markdown reply completes', async () => {
    const h = await createHarness();
    h.agent.setEvents([
      { type: 'text', delta: '处理好了' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_direct_at',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_topic',
        content: '@Bridge 处理一下',
      }),
    );
    await waitFor(() => h.channel.markdownContents.some((content) => content.includes('<at id="ou_user"></at>')));

    const finalContent = h.channel.markdownContents.at(-1) ?? '';
    expect(finalContent).toContain('处理好了');
    expect(finalContent.trim()).toMatch(/<at id="ou_user"><\/at>$/);
    expect(count(finalContent, '<at id="ou_user"></at>')).toBe(1);
    expect(h.channel.markdownContents.some((content) =>
      content.includes('正在') && content.includes('<at id="ou_user"></at>'),
    )).toBe(false);
  });

  it('auto-runs only for configured topic root messages without requiring later replies to mention the bot', async () => {
    const h = await createHarness({
      autoReplyTopicChats: ['oc_topic_chat'],
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_topic_root',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_topic',
        content: '新话题：帮我看一下这个部署',
        mentionedBot: false,
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions[0]?.prompt).toContain('新话题：帮我看一下这个部署');

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_topic_reply',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_topic',
        content: '补充一句，但没有 @',
        mentionedBot: false,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 750));

    expect(h.agent.runOptions).toHaveLength(1);
  });
});

async function createHarness(options: {
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
  historyMessages?: unknown[];
  autoReplyTopicChats?: string[];
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('topic-quote-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedChats: ['oc_topic_chat'],
      autoReplyTopicChats: options.autoReplyTopicChats ?? [],
      allowedUsers: ['ou_user'],
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(options: {
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
  historyMessages?: unknown[];
  autoReplyTopicChats?: string[];
} = {}): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  const markdownContents: string[] = [];
  const chatMode = options.chatMode ?? 'topic';
  const quotedMessages = options.quotedMessages ?? {
    om_topic_root: 'topic root content',
  };
  return {
    handlers,
    markdownContents,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      im: {
        v1: {
          message: {
            list: vi.fn(async (request: { params?: { container_id_type?: string; container_id?: string } }) => {
              const params = request.params ?? {};
              const items = (options.historyMessages ?? []).filter((item) =>
                historyBelongsToContainer(item, params.container_id_type, params.container_id),
              );
              return {
                data: {
                  has_more: false,
                  items,
                },
              };
            }),
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    getAppInfo: vi.fn(async () => ({ ownerId: 'ou_owner' })),
    listChats: vi.fn(async () => []),
    fetchRawMessage: vi.fn(async (messageId: string) => [
      {
        message_id: messageId,
        msg_type: 'text',
        body: {
          content: JSON.stringify({
            text: quotedMessages[messageId] ?? 'quoted content',
          }),
        },
        create_time: '1760000000000',
        sender: { id: 'ou_quote_sender' },
      },
    ]),
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return chatMode;
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send() {},
    async stream(_chatId, input) {
      if (isMarkdownStreamInput(input)) {
        await input.markdown({
          setContent: async (content: string) => {
            markdownContents.push(content);
          },
        });
      }
    },
  };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(input: {
  messageId: string;
  rootId: string;
  parentId: string;
  threadId?: string;
  content: string;
  mentionedBot?: boolean;
}): NormalizedMessage {
  const mentionedBot = input.mentionedBot ?? true;
  return {
    messageId: input.messageId,
    chatId: 'oc_topic_chat',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions: mentionedBot ? [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }] : [],
    mentionAll: false,
    mentionedBot,
    rootId: input.rootId,
    parentId: input.parentId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    replyToMessageId: input.parentId,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function historyMessage(input: {
  messageId: string;
  rootId: string;
  threadId: string;
  senderId: string;
  senderName: string;
  text: string;
  createTime: string;
}): unknown {
  return {
    message_id: input.messageId,
    root_id: input.rootId,
    thread_id: input.threadId,
    msg_type: 'text',
    create_time: input.createTime,
    chat_id: 'oc_topic_chat',
    sender: {
      id: input.senderId,
      id_type: 'open_id',
      sender_type: 'user',
      sender_name: input.senderName,
    },
    body: {
      content: JSON.stringify({ text: input.text }),
    },
  };
}

function historyBelongsToContainer(
  item: unknown,
  containerIdType: string | undefined,
  containerId: string | undefined,
): boolean {
  if (containerIdType !== 'thread' || !containerId) return true;
  const raw = item as {
    message_id?: string;
    thread_id?: string;
    root_id?: string;
    parent_id?: string;
  };
  return [raw.message_id, raw.thread_id, raw.root_id, raw.parent_id].includes(containerId);
}

function readSection(prompt: string, tag: string): unknown {
  const match = prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  if (!match) throw new Error(`missing section ${tag}`);
  return JSON.parse(match[1] ?? 'null') as unknown;
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}

function count(input: string, pattern: string): number {
  return input.split(pattern).length - 1;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
