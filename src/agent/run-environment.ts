import { mergeProcessEnv } from '../platform/spawn';

/** Drop stale run credentials and broker-only secrets before injecting the current run snapshot. */
export function buildAgentEnvironment(
  overrides: NodeJS.ProcessEnv,
  runEnv?: Readonly<Record<string, string>>,
  removeEnvKeys: readonly string[] = [],
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const removed = new Set(removeEnvKeys.map(key => key.toLowerCase()));
  const clean = Object.fromEntries(Object.entries(base).filter(([key]) =>
    !/^PALLAS_ADMIN_|^BRIDGE_ADMIN_/i.test(key) && !removed.has(key.toLowerCase()),
  ));
  return mergeProcessEnv(mergeProcessEnv(clean, overrides), runEnv ? { ...runEnv } : {});
}
