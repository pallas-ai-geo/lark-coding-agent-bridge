import { timingSafeEqual, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ProfileConfig } from '../config/profile-schema';
import type { SecretInput } from '../config/schema';
import { resolveSecretInput } from '../config/secret-resolver';
import { paths } from '../config/paths';
import type { KeystorePaths } from '../config/keystore';
import type { RunCredentials } from './run-credentials';

export interface AdminMessageIdentity {
  messageId: string;
  chatId: string;
  senderId: string;
}

interface Grant {
  jwt: string;
  jti: string;
  manager_token: string;
  expires_at: number;
  lease_seconds: number;
  app_id: string;
  actor_open_id: string;
  message_id: string;
  chat_id: string;
  run_id: string;
  region: string;
  environment: string;
}

function secretEnvironmentNames(input: SecretInput): string[] {
  if (typeof input === 'string') return /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(input)?.slice(1) ?? [];
  return input.source === 'env' ? [input.id] : [];
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Long-lived service credentials stay here, outside the agent's process environment. */
export async function authorizeAdminMessage(
  profile: ProfileConfig, identity: AdminMessageIdentity, runId: string,
  secretPaths: KeystorePaths = paths,
): Promise<RunCredentials> {
  const config = profile.adminAuthorization;
  if (!config) throw new Error('Admin authorization is not configured');
  const [bridgeSecret, cfSecret] = await Promise.all([
    resolveSecretInput(config.bridgeSecret, profile.secrets, profile.accounts.app.id, secretPaths),
    resolveSecretInput(config.cfAccessClientSecret, profile.secrets, profile.accounts.app.id, secretPaths),
  ]);
  const result = await fetch(`${config.issuerUrl}/bridge/authorize`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${bridgeSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message_id: identity.messageId, chat_id: identity.chatId,
      actor_open_id: identity.senderId, run_id: runId, app_id: profile.accounts.app.id,
      region: config.region, environment: config.environment }),
  });
  if (!result.ok) throw new Error('Independent Feishu message verification denied');
  const grant = await result.json() as Grant;
  if (typeof grant.jwt !== 'string' || typeof grant.manager_token !== 'string' || !/^[a-f0-9]{64}$/.test(grant.jti)
      || grant.message_id !== identity.messageId || grant.actor_open_id !== identity.senderId
      || grant.chat_id !== identity.chatId || grant.run_id !== runId || grant.app_id !== profile.accounts.app.id
      || grant.region !== config.region || grant.environment !== config.environment
      || !Number.isFinite(grant.expires_at) || grant.expires_at * 1000 <= Date.now()
      || grant.expires_at * 1000 > Date.now() + 3600_000
      || grant.lease_seconds !== 60) throw new Error('Authorization response does not match this message');

  const management = async (action: 'renew' | 'revoke'): Promise<void> => {
    const response = await fetch(`${config.issuerUrl}/bridge/leases/${grant.jti}/${action}`, {
      method: 'POST', headers: { authorization: `Bearer ${grant.manager_token}` },
      redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Message authorization lease unavailable');
  };
  const upstreamHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...extra,
    authorization: `Bearer ${grant.jwt}`,
    'CF-Access-Client-Id': config.cfAccessClientId,
    'CF-Access-Client-Secret': cfSecret,
    'X-Pallas-Region': config.region,
    'X-Pallas-Environment': config.environment,
  });

  // Fail before agent spawn if the independently verified mailbox has no active Admin access.
  try {
    const access = await fetch(`${config.adminUrl}/api/developer/me`, {
      headers: upstreamHeaders(), redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!access.ok) throw new Error('Admin access denied for this message');
  } catch {
    await management('revoke').catch(() => {});
    throw new Error('Admin access denied for this message');
  }

  const prefix = `/${randomUUID()}`;
  let active = true;
  let disposed: Promise<void> | undefined;
  let lost = false;
  const listeners = new Set<() => void>();
  const requests = new Set<AbortController>();
  const server = createServer((request, response) => { void proxy(request, response); });

  async function proxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let controller: AbortController | undefined;
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (!active || Date.now() >= grant.expires_at * 1000 || request.headers.origin
          || !url.pathname.startsWith(`${prefix}/api/admin/`)
          || !same(request.headers.authorization ?? '', `Bearer ${grant.jwt}`)) {
        response.writeHead(403).end('Message authorization denied'); return;
      }
      const method = request.method ?? 'GET';
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        response.writeHead(405).end(); return;
      }
      const body: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 16 * 1024 * 1024) throw new Error('Request body too large');
        body.push(buffer);
      }
      if (!active) { response.writeHead(403).end(); return; }
      const apiPath = url.pathname.slice(`${prefix}/api/admin/`.length);
      const target = new URL(`/api/developer/admin/${apiPath}`, config!.adminUrl);
      target.search = url.search;
      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'accept', 'idempotency-key']) {
        const value = request.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      controller = new AbortController(); requests.add(controller);
      const remote = await fetch(target, { method, headers: upstreamHeaders(headers), redirect: 'manual',
        signal: controller.signal, ...(!['GET', 'HEAD'].includes(method) ? { body: new Uint8Array(Buffer.concat(body)) } : {}) });
      const output: Record<string, string> = { 'cache-control': 'no-store' };
      for (const name of ['content-type', 'content-disposition']) {
        const value = remote.headers.get(name); if (value) output[name] = value;
      }
      response.writeHead(remote.status, output);
      if (remote.body) await pipeline(Readable.fromWeb(remote.body as import('node:stream/web').ReadableStream), response);
      else response.end();
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end('Admin request unavailable');
    } finally { if (controller) requests.delete(controller); }
  }

  const notifyLost = (): void => {
    if (lost || !active) return;
    lost = true; active = false;
    for (const request of requests) request.abort();
    server.closeAllConnections();
    for (const listener of listeners) listener();
  };
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (!active || renewing) return;
    renewing = true;
    void management('renew').catch(notifyLost).finally(() => { renewing = false; });
  }, 20_000);
  heartbeat.unref();
  const deadline = setTimeout(notifyLost, Math.max(1, grant.expires_at * 1000 - Date.now()));
  deadline.unref();

  async function dispose(): Promise<void> {
    if (disposed) return disposed;
    active = false; clearInterval(heartbeat); clearTimeout(deadline);
    for (const request of requests) request.abort();
    server.closeAllConnections();
    disposed = (async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      // On network failure the issuer's 60-second lease still expires without further renewals.
      await management('revoke').catch(() => {});
      listeners.clear();
    })();
    return disposed;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) { await dispose(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') { await dispose(); throw new Error('Local Admin proxy unavailable'); }
  return {
    env: { PALLAS_ADMIN_JWT: grant.jwt, PALLAS_ADMIN_API_BASE_URL: `http://127.0.0.1:${address.port}${prefix}/api`,
      PALLAS_ADMIN_REGION: config.region, PALLAS_ADMIN_ENVIRONMENT: config.environment },
    removeEnvKeys: [...secretEnvironmentNames(config.bridgeSecret), ...secretEnvironmentNames(config.cfAccessClientSecret)],
    dispose,
    onLost(listener) {
      listeners.add(listener);
      if (lost) queueMicrotask(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
