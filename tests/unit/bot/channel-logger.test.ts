import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as channelModule from '../../../src/bot/channel.js';
import { closeLogger, configureLogger, flushLogger } from '../../../src/core/logger.js';

let logsDir = '';

beforeEach(async () => {
  logsDir = await mkdtemp(join(tmpdir(), 'channel-logger-'));
  configureLogger({
    logsDir,
    now: () => new Date('2026-05-25T12:00:00.000Z'),
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeLogger();
  await rm(logsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

describe('Lark SDK logger noise filtering', () => {
  it('suppresses optional wiki-node permission failures that fall back to the original file token', () => {
    const shouldSuppress = (
      channelModule as {
        shouldSuppressSdkErrorLog?: (args: unknown[]) => boolean;
      }
    ).shouldSuppressSdkErrorLog;

    expect(
      shouldSuppress?.([
        [
          {
            message: 'Request failed with status code 400',
            config: {
              method: 'get',
              url: 'https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node',
            },
            response: {
              data: {
                code: 99991672,
                msg: 'Access denied. One of the following scopes is required: [wiki:node:read].',
              },
            },
          },
          {
            code: 99991672,
            msg: 'Access denied. One of the following scopes is required: [wiki:node:read].',
          },
        ],
      ]),
    ).toBe(true);
  });

  it('keeps unrelated permission failures visible', () => {
    const shouldSuppress = (
      channelModule as {
        shouldSuppressSdkErrorLog?: (args: unknown[]) => boolean;
      }
    ).shouldSuppressSdkErrorLog;

    expect(
      shouldSuppress?.([
        {
          message: 'Request failed with status code 400',
          config: {
            method: 'post',
            url: 'https://open.feishu.cn/open-apis/im/v1/messages',
          },
          response: {
            data: {
              code: 99991672,
              msg: 'Access denied.',
            },
          },
        },
      ]),
    ).toBe(false);
  });

  it('logs markdown stream update failures as structured sdk diagnostics', async () => {
    const sdkLogger = (
      channelModule as {
        buildQuietLogger?: () => {
          warn: (...args: unknown[]) => void;
        };
      }
    ).buildQuietLogger?.();

    sdkLogger?.warn('[stream] update failed', {
      name: 'AxiosError',
      message: 'Request failed with status code 400',
      code: 'ERR_BAD_REQUEST',
      config: {
        method: 'post',
        url:
          'https://open.feishu.cn/open-apis/cardkit/v1/cards/card-id/elements/stream_md/content' +
          '?tenant_access_token=tenant-secret',
        headers: {
          authorization: 'Bearer raw-token',
        },
      },
      response: {
        status: 400,
        data: {
          code: 99992402,
          msg: 'field validation failed',
          request_id: 'req-123',
        },
      },
    });
    await flushLogger();

    const text = await readTodayLog();
    const entry = JSON.parse(text) as {
      phase: string;
      event: string;
      errorName: string;
      err: string;
      errorCode: string;
      apiStatus: number;
      apiCode: number;
      apiMsg: string;
      method: string;
      url: string;
      requestId: string;
    };

    expect(entry.phase).toBe('sdk');
    expect(entry.event).toBe('stream_update_failed');
    expect(entry.errorName).toBe('AxiosError');
    expect(entry.err).toBe('Request failed with status code 400');
    expect(entry.errorCode).toBe('ERR_BAD_REQUEST');
    expect(entry.apiStatus).toBe(400);
    expect(entry.apiCode).toBe(99992402);
    expect(entry.apiMsg).toBe('field validation failed');
    expect(entry.method).toBe('post');
    expect(entry.url).toContain('tenant_access_token=[REDACTED]');
    expect(entry.requestId).toBe('req-123');
    expect(text).not.toContain('tenant-secret');
    expect(text).not.toContain('raw-token');
    expect(text).not.toContain('headers');
  });

  it('logs markdown stream update retries with attempt metadata', async () => {
    const sdkLogger = (
      channelModule as {
        buildQuietLogger?: () => {
          warn: (...args: unknown[]) => void;
        };
      }
    ).buildQuietLogger?.();

    sdkLogger?.warn(
      '[stream] update retry',
      {
        name: 'AxiosError',
        message: 'Request failed with status code 503',
        response: {
          status: 503,
          data: {
            code: 230020,
            msg: 'service busy',
          },
        },
      },
      { attempt: 2, maxAttempts: 4, delayMs: 1000 },
    );
    await flushLogger();

    const text = await readTodayLog();
    const entry = JSON.parse(text) as {
      phase: string;
      event: string;
      apiStatus: number;
      apiCode: number;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
    };

    expect(entry.phase).toBe('sdk');
    expect(entry.event).toBe('stream_update_retry');
    expect(entry.apiStatus).toBe(503);
    expect(entry.apiCode).toBe(230020);
    expect(entry.attempt).toBe(2);
    expect(entry.maxAttempts).toBe(4);
    expect(entry.delayMs).toBe(1000);
  });
});

async function readTodayLog(): Promise<string> {
  return readFile(join(logsDir, 'bridge-20260525.jsonl'), 'utf8');
}
