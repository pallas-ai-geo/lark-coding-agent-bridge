import { mergeProcessEnv } from '../platform/spawn';

export function adminRunInstructions(env?: Readonly<Record<string, string>>): string {
  if (!env?.PALLAS_ADMIN_JWT || !env.PALLAS_ADMIN_API_BASE_URL) return '';
  return '\n本轮消息已获得 Pallas Admin 授权。仅通过环境变量 PALLAS_ADMIN_API_BASE_URL 指定的本轮代理访问 /admin/*，'
    + '使用 Authorization: Bearer $PALLAS_ADMIN_JWT。不要输出、记录或写入 JWT 的值，不使用历史消息中的凭证或代理地址。'
    + '权限拒绝或授权过期时停止受保护操作，不寻找其他用户凭证或绕过鉴权。\n';
}

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
