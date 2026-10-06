import { describe, expect, it } from 'vitest';
import { buildAgentEnvironment } from '../../../src/agent/run-environment';

describe('Run environment isolation', () => {
  it('removes inherited admin/broker credentials and does not mutate the parent or share snapshots', () => {
    const base = { PATH: '/bin', PALLAS_ADMIN_JWT: 'stale', pallas_admin_api_base_url: 'stale-url',
      BRIDGE_ADMIN_SECRET: 'issuer-service-secret', OTHER_SERVICE_SECRET: 'cf-secret' };
    const alice = buildAgentEnvironment({}, { PALLAS_ADMIN_JWT: 'alice-jwt' }, ['OTHER_SERVICE_SECRET'], base);
    const bob = buildAgentEnvironment({}, { PALLAS_ADMIN_JWT: 'bob-jwt' }, ['OTHER_SERVICE_SECRET'], base);
    const anonymous = buildAgentEnvironment({}, undefined, ['OTHER_SERVICE_SECRET'], base);
    expect(alice).toEqual({ PATH: '/bin', PALLAS_ADMIN_JWT: 'alice-jwt' });
    expect(bob).toEqual({ PATH: '/bin', PALLAS_ADMIN_JWT: 'bob-jwt' });
    expect(anonymous).toEqual({ PATH: '/bin' });
    expect(base.PALLAS_ADMIN_JWT).toBe('stale');
    expect(alice).not.toBe(bob);
  });
});
