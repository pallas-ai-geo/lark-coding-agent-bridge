import { mergeProcessEnv } from '../platform/spawn';

export function adminRunInstructions(env?: Readonly<Record<string, string>>): string {
  if (!env?.PALLAS_ADMIN_JWT || !env.PALLAS_ADMIN_API_BASE_URL) return '';
  return '\n本轮消息已获得 Pallas Admin 授权。调用 Admin 优先使用仓库 commands/admin.sh CLI，'
    + '必须显式传 --region "$PALLAS_ADMIN_REGION" --environment "$PALLAS_ADMIN_ENVIRONMENT" '
    + '--base-url "$PALLAS_ADMIN_API_BASE_URL"。凭证从 PALLAS_ADMIN_JWT 环境变量读取。'
    + '写操作执行前必须二次确认，除非用户明确免除二次确认或给出最终授权。'
    + '不要输出、记录或写入 JWT，不使用历史凭证；本轮结束后授权撤销。';
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
