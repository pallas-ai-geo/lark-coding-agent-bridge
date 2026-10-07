import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizeAdminMessage } from '../../../src/runtime/admin-authorization';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import type { RunCredentials } from '../../../src/runtime/run-credentials';

const realFetch = globalThis.fetch;
const cleanups: RunCredentials[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(credential => credential.dispose())); vi.unstubAllGlobals(); });

function harness(accessAllowed = true) {
  const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'cli_test', secret: 'app-secret', tenant: 'feishu' } }, codex: { binaryPath: 'codex' } });
  profile.adminAuthorization = { issuerUrl: 'https://issuer.example', adminUrl: 'https://admin.example',
    bridgeSecret: 'issuer-service-secret', cfAccessClientId: 'cf-service-id', cfAccessClientSecret: 'cf-service-secret', region: 'domestic', environment: 'test' };
  const requests: Array<{ url: string; headers: Headers; body?: unknown }> = [];
  const jwt = 'test-message-jwt';
  vi.stubGlobal('fetch', vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
    const url = String(target);
    if (url.startsWith('http://127.0.0.1:')) return realFetch(target, init);
    const headers = new Headers(init?.headers);
    requests.push({ url, headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/bridge/authorize')) return Response.json({ jwt, jti: 'a'.repeat(64), manager_token: 'parent-only-manager',
      app_id: 'cli_test', actor_open_id: 'ou_alice', message_id: 'om_message', chat_id: 'oc_chat', run_id: 'run-1',
      region: 'domestic', environment: 'test', expires_at: Math.floor(Date.now() / 1000) + 3600, lease_seconds: 60 });
    if (url.endsWith('/api/developer/me')) return Response.json({ email: 'alice@pallasai.net' }, { status: accessAllowed ? 200 : 403 });
    if (url.endsWith('/revoke')) return Response.json({ active: false });
    if (url.includes('/api/developer/admin/')) return Response.json({ ok: true });
    throw new Error('Unexpected network request');
  }));
  return { profile, requests, jwt };
}

describe('Per-message Admin proxy', () => {
  it('IP mode sends only the message JWT and does not resolve or send CF service credentials', async () => {
    const h = harness();
    h.profile.adminAuthorization = { issuerUrl: 'https://issuer.example', adminUrl: 'https://admin.example',
      bridgeSecret: 'issuer-service-secret', machineAuth: 'ip', region: 'domestic', environment: 'test' };
    const credential = await authorizeAdminMessage(h.profile, { senderId: 'ou_alice', chatId: 'oc_chat', messageId: 'om_message' }, 'run-1');
    cleanups.push(credential);
    expect((await realFetch(`${credential.env.PALLAS_ADMIN_API_BASE_URL}/admin/groups`, {
      headers: { authorization: `Bearer ${h.jwt}` },
    })).status).toBe(200);
    const calls = h.requests.filter(request => request.url.startsWith('https://admin.example/'));
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers.get('CF-Access-Client-Id')).toBeNull();
      expect(call.headers.get('CF-Access-Client-Secret')).toBeNull();
      expect(call.headers.get('Authorization')).toBe(`Bearer ${h.jwt}`);
    }
  });
  it('keeps long-lived secrets out of the run env, binds the target environment and denies a different run token', async () => {
    const h = harness();
    const credential = await authorizeAdminMessage(h.profile, { senderId: 'ou_alice', chatId: 'oc_chat', messageId: 'om_message' }, 'run-1');
    cleanups.push(credential);
    expect(JSON.stringify(credential.env)).not.toContain('cf-service-secret');
    expect(JSON.stringify(credential.env)).not.toContain('issuer-service-secret');
    expect(JSON.stringify(credential.env)).not.toContain('parent-only-manager');
    const url = `${credential.env.PALLAS_ADMIN_API_BASE_URL}/admin/groups`;
    expect((await realFetch(url, { headers: { authorization: 'Bearer other-run-token' } })).status).toBe(403);
    const result = await realFetch(url, { headers: { authorization: `Bearer ${h.jwt}`, 'X-Pallas-Environment': 'production', 'X-Pallas-User-Email': 'admin@pallasai.net' } });
    expect(result.status).toBe(200);
    const upstream = h.requests.find(request => request.url.endsWith('/api/developer/admin/groups'))!;
    expect(upstream.headers.get('CF-Access-Client-Secret')).toBe('cf-service-secret');
    expect(upstream.headers.get('X-Pallas-Environment')).toBe('test');
    expect(upstream.headers.get('X-Pallas-User-Email')).toBeNull();
    await credential.dispose();
    expect(h.requests.filter(request => request.url.endsWith('/revoke'))).toHaveLength(1);
    await expect(realFetch(url, { headers: { authorization: `Bearer ${h.jwt}` } })).rejects.toThrow();
  });
  it('revokes and does not start a local proxy when Admin rejects the mailbox', async () => {
    const h = harness(false);
    await expect(authorizeAdminMessage(h.profile, { senderId: 'ou_alice', chatId: 'oc_chat', messageId: 'om_message' }, 'run-1')).rejects.toThrow('Admin access denied');
    expect(h.requests.filter(request => request.url.endsWith('/revoke'))).toHaveLength(1);
    expect(h.requests.some(request => request.url.includes('/api/developer/admin/'))).toBe(false);
  });
});
