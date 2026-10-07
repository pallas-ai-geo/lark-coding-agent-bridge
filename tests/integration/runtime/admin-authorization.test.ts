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
    machineAuth: 'service-token', cfAccessClientId: 'cf-service-id', cfAccessClientSecret: 'cf-service-secret' };
  const requests: Array<{ url: string; headers: Headers; body?: unknown }> = [];
  const jwt = 'message-jwt-ou_alice-run-1';
  vi.stubGlobal('fetch', vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
    const url = String(target);
    if (url.startsWith('http://127.0.0.1:')) return realFetch(target, init);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, string> : undefined;
    requests.push({ url, headers, body });
    if (url.endsWith('/bridge/authorize')) return Response.json({ jwt: `message-jwt-${body!.actor_open_id}-${body!.run_id}`, jti: 'a'.repeat(64), manager_token: 'parent-only-manager',
      app_id: body!.app_id, actor_open_id: body!.actor_open_id, message_id: body!.message_id, chat_id: body!.chat_id, run_id: body!.run_id,
      expires_at: Math.floor(Date.now() / 1000) + 3600, lease_seconds: 60 });
    if (url.endsWith('/api/developer/me')) return Response.json({ email: 'alice@pallasai.net' }, { status: accessAllowed ? 200 : 403 });
    if (url.endsWith('/revoke') || url.endsWith('/renew')) return Response.json({ active: false });
    if (url.includes('/api/developer/admin/')) return Response.json({ ok: accessAllowed }, { status: accessAllowed ? 200 : 403 });
    throw new Error('Unexpected network request');
  }));
  return { profile, requests, jwt };
}
const identity = { senderId: 'ou_alice', chatId: 'oc_chat', messageId: 'om_message' };
function headers(jwt: string, region = 'domestic', environment = 'production') {
  return { authorization: `Bearer ${jwt}`, 'X-Pallas-Region': region, 'X-Pallas-Environment': environment };
}
describe('Per-message Admin proxy', () => {
  it('IP mode needs no broker credential, forwards the message JWT and keeps CF secrets outside the run', async () => {
    const h = harness();
    h.profile.adminAuthorization = { issuerUrl: 'https://issuer.example', adminUrl: 'https://admin.example', machineAuth: 'ip' };
    const credential = await authorizeAdminMessage(h.profile, identity, 'run-1'); cleanups.push(credential);
    const authorization = h.requests[0]; if (!authorization) throw new Error('Missing issuer request');
    expect(authorization.headers.get('Authorization')).toBeNull();
    expect(authorization.body).toEqual({ message_id: 'om_message', chat_id: 'oc_chat', actor_open_id: 'ou_alice', run_id: 'run-1', app_id: 'cli_test' });
    expect(credential.env).not.toHaveProperty('PALLAS_ADMIN_REGION');
    expect(credential.env).not.toHaveProperty('PALLAS_ADMIN_ENVIRONMENT');
    expect((await realFetch(`${credential.env.PALLAS_ADMIN_API_BASE_URL}/api/developer/admin/groups`, { headers: headers(h.jwt) })).status).toBe(200);
    const call = h.requests.find(request => request.url.startsWith('https://admin.example/'))!;
    expect(call.headers.get('CF-Access-Client-Id')).toBeNull();
    expect(call.headers.get('CF-Access-Client-Secret')).toBeNull();
    expect(call.headers.get('Authorization')).toBe(`Bearer ${h.jwt}`);
  });
  it('passes each explicit target to Admin, rejects missing/unsupported targets and never forwards caller identities', async () => {
    const h = harness(); const credential = await authorizeAdminMessage(h.profile, identity, 'run-1'); cleanups.push(credential);
    expect(JSON.stringify(credential.env)).not.toContain('cf-service-secret');
    expect(JSON.stringify(credential.env)).not.toContain('parent-only-manager');
    const url = `${credential.env.PALLAS_ADMIN_API_BASE_URL}/api/developer/admin/groups`;
    expect((await realFetch(url, { headers: headers('other-run-token') })).status).toBe(403);
    expect((await realFetch(url, { headers: { authorization: `Bearer ${h.jwt}` } })).status).toBe(400);
    expect((await realFetch(url, { headers: headers(h.jwt, 'overseas', 'test') })).status).toBe(400);
    for (const [region, environment] of [['domestic','test'],['domestic','production'],['overseas','production']]) {
      expect((await realFetch(url, { headers: { ...headers(h.jwt, region, environment), 'X-Pallas-User-Email': 'admin@pallasai.net' } })).status).toBe(200);
      const call = h.requests.at(-1)!;
      expect(call.headers.get('X-Pallas-Region')).toBe(region);
      expect(call.headers.get('X-Pallas-Environment')).toBe(environment);
      expect(call.headers.get('CF-Access-Client-Secret')).toBe('cf-service-secret');
      expect(call.headers.get('X-Pallas-User-Email')).toBeNull();
    }
    await credential.dispose(); expect(h.requests.filter(request => request.url.endsWith('/revoke'))).toHaveLength(1);
    await expect(realFetch(url, { headers: headers(h.jwt) })).rejects.toThrow();
  });
  it('injects a verified user identity with no Admin membership and lets Admin reject individual requests', async () => {
    const h = harness(false); const credential = await authorizeAdminMessage(h.profile, identity, 'run-1'); cleanups.push(credential);
    expect(credential.env.PALLAS_ADMIN_JWT).toBe(h.jwt);
    expect(h.requests.some(request => request.url.includes('/api/developer/'))).toBe(false);
    expect((await realFetch(`${credential.env.PALLAS_ADMIN_API_BASE_URL}/api/developer/me`, { headers: headers(h.jwt) })).status).toBe(403);
    expect((await realFetch(`${credential.env.PALLAS_ADMIN_API_BASE_URL}/api/developer/admin/groups`, { headers: headers(h.jwt) })).status).toBe(403);
  });
  it('surfaces only allowlisted issuer reasons and never includes arbitrary error bodies', async () => {
    const h=harness();
    vi.stubGlobal('fetch',async()=>Response.json({error_code:'missing-bot-mention'}, {status:403}));
    await expect(authorizeAdminMessage(h.profile,identity,'run-1')).rejects.toMatchObject({
      code:'message-authorization-denied',message:'飞书消息身份校验或 JWT 签发失败（missing-bot-mention）',
    });
    vi.stubGlobal('fetch',async()=>Response.json({error_code:'arbitrary-secret-value',details:'private upstream response'}, {status:403}));
    await expect(authorizeAdminMessage(h.profile,identity,'run-1')).rejects.toMatchObject({
      code:'message-authorization-denied',message:'飞书消息身份校验或 JWT 签发失败（issuer-http-403）',
    });
  });
  it('keeps consecutive users and their proxy tokens separate in the same chat', async () => {
    const h = harness(); const alice = await authorizeAdminMessage(h.profile, identity, 'run-1'); cleanups.push(alice);
    const bob = await authorizeAdminMessage(h.profile, { ...identity, messageId: 'om_bob', senderId: 'ou_bob' }, 'run-2'); cleanups.push(bob);
    const a = `${alice.env.PALLAS_ADMIN_API_BASE_URL}/api/developer/admin/groups`;
    const b = `${bob.env.PALLAS_ADMIN_API_BASE_URL}/api/developer/admin/groups`;
    const aliceJwt = alice.env.PALLAS_ADMIN_JWT, bobJwt = bob.env.PALLAS_ADMIN_JWT;
    if (!aliceJwt || !bobJwt) throw new Error('Missing per-run JWT');
    expect(aliceJwt).not.toBe(bobJwt);
    expect((await realFetch(a, { headers: headers(bobJwt) })).status).toBe(403);
    expect((await realFetch(b, { headers: headers(aliceJwt) })).status).toBe(403);
    expect((await realFetch(b, { headers: headers(bobJwt) })).status).toBe(200);
    await alice.dispose();
    expect((await realFetch(b, { headers: headers(bobJwt) })).status).toBe(200);
  });
});
