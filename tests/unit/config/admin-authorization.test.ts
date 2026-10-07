import { describe, expect, it } from 'vitest';
import { createDefaultProfileConfig, normalizeProfileConfig, effectiveLarkCliIdentity } from '../../../src/config/profile-schema';

const authorization = { issuerUrl: 'https://issuer.example', adminUrl: 'https://admin.example',
  machineAuth: 'service-token' as const, cfAccessClientId: 'client.access',
  cfAccessClientSecret: { source: 'env' as const, id: 'PALLAS_ADMIN_CF_SECRET' } };
const base = () => createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'cli', secret: 'secret', tenant: 'feishu' } }, codex: { binaryPath: 'codex' } });

describe('Admin authorization profile boundary', () => {
  it('accepts explicit IP authentication without CF credentials and rejects mixed or partial settings', () => {
    const { cfAccessClientId: _id, cfAccessClientSecret: _secret, machineAuth: _mode, ...common } = authorization;
    const ip = { ...common, machineAuth: 'ip' as const };
    expect(normalizeProfileConfig({ ...base(), adminAuthorization: ip }).adminAuthorization).toEqual(ip);
    for (const invalid of [{ ...authorization, machineAuth: 'ip' }, { ...common, machineAuth: 'service-token' },
      { ...common, machineAuth: 'unknown' }, { ...common, cfAccessClientId: 'client.access' }]) {
      expect(() => normalizeProfileConfig({ ...base(), adminAuthorization: invalid })).toThrow();
    }
  });
  it('accepts identity-only IP configuration and strips obsolete broker/environment settings', () => {
    const profile = normalizeProfileConfig({ ...base(), adminAuthorization: {
      issuerUrl: 'https://issuer.example', adminUrl: 'https://admin.example',
      issuerJwt: { source: 'env', id: 'PALLAS_ADMIN_JWT' }, region: 'domestic', environment: 'test',
    } });
    expect(profile.adminAuthorization).toEqual({ issuerUrl: 'https://issuer.example', adminUrl: 'https://admin.example', machineAuth: 'ip' });
  });
  it('preserves opt-in configuration and forces bot-only without discarding the saved preference', () => {
    const profile = normalizeProfileConfig({ ...base(), adminAuthorization: authorization, larkCli: { identityPreset: 'user-default' } });
    expect(profile.adminAuthorization).toEqual(authorization);
    expect(effectiveLarkCliIdentity(profile)).toBe('bot-only');
    expect(profile.larkCli.identityPreset).toBe('user-default');
    expect(effectiveLarkCliIdentity({ ...profile, adminAuthorization: undefined })).toBe('user-default');
  });
  it('rejects insecure origins and secrets that could leak through inherited env', () => {
    for (const override of [{ issuerUrl: 'http://issuer.example' }, { adminUrl: 'https://user:password@admin.example' },
      { adminUrl: 'https://admin.example/unexpected' },
      { cfAccessClientSecret: { source: 'env', id: 'ORDINARY_INHERITED_SECRET' } }]) {
      expect(() => normalizeProfileConfig({ ...base(), adminAuthorization: { ...authorization, ...override } })).toThrow();
    }
    expect(base().adminAuthorization).toBeUndefined();
  });
});
