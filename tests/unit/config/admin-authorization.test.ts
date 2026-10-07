import { describe, expect, it } from 'vitest';
import { createDefaultProfileConfig, normalizeProfileConfig, effectiveLarkCliIdentity } from '../../../src/config/profile-schema';

const authorization = { issuerUrl: 'https://issuer.example', adminUrl: 'https://admin.example',
  bridgeSecret: { source: 'env' as const, id: 'BRIDGE_ADMIN_ISSUER_SECRET' }, cfAccessClientId: 'client.access',
  cfAccessClientSecret: { source: 'env' as const, id: 'BRIDGE_ADMIN_CF_SECRET' }, region: 'domestic' as const, environment: 'test' as const };
const base = () => createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'cli', secret: 'secret', tenant: 'feishu' } }, codex: { binaryPath: 'codex' } });

describe('Admin authorization profile boundary', () => {
  it('accepts explicit IP authentication without CF credentials and rejects mixed or partial settings', () => {
    const { cfAccessClientId: _id, cfAccessClientSecret: _secret, ...common } = authorization;
    const ip = { ...common, machineAuth: 'ip' };
    expect(normalizeProfileConfig({ ...base(), adminAuthorization: ip }).adminAuthorization).toEqual(ip);
    for (const invalid of [{ ...authorization, machineAuth: 'ip' }, { ...common },
      { ...common, machineAuth: 'unknown' }, { ...common, cfAccessClientId: 'client.access' }]) {
      expect(() => normalizeProfileConfig({ ...base(), adminAuthorization: invalid })).toThrow();
    }
  });
  it('preserves opt-in configuration and forces bot-only without discarding the saved preference', () => {
    const profile = normalizeProfileConfig({ ...base(), adminAuthorization: authorization, larkCli: { identityPreset: 'user-default' } });
    expect(profile.adminAuthorization).toEqual(authorization);
    expect(effectiveLarkCliIdentity(profile)).toBe('bot-only');
    expect(profile.larkCli.identityPreset).toBe('user-default');
    expect(effectiveLarkCliIdentity({ ...profile, adminAuthorization: undefined })).toBe('user-default');
  });
  it('rejects insecure origins, unsupported environments and secrets that could leak through inherited env', () => {
    for (const override of [{ issuerUrl: 'http://issuer.example' }, { adminUrl: 'https://user:password@admin.example' },
      { adminUrl: 'https://admin.example/unexpected' }, { region: 'overseas', environment: 'test' },
      { bridgeSecret: { source: 'env', id: 'ORDINARY_INHERITED_SECRET' } }]) {
      expect(() => normalizeProfileConfig({ ...base(), adminAuthorization: { ...authorization, ...override } })).toThrow();
    }
    expect(base().adminAuthorization).toBeUndefined();
  });
});
