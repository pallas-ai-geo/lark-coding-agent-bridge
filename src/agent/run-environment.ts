import { mergeProcessEnv } from '../platform/spawn';

export function adminRunInstructions(env?: Readonly<Record<string, string>>): string {
  const routing = '\nPallas 业务数据读取必须走目标数据库的只读 SQL：包括查询、检索、列表、统计、资料导出以及修改前后的数据核对。'
    + '资料导出只是读取已有资料并生成本地文件，不是 Admin 增删改操作；不得调用 commands/admin.sh 或 Admin API 获取业务数据，'
    + '也不得先通过 CLI 查询用户、团队、group 或做 Admin 身份/权限预检。'
    + 'PostgreSQL 按 pallas-postgres skill；Admin 自身 RBAC/审计 D1 按 pallas-admin skill 的只读数据库入口。'
    + 'SQL 查询依据已授权的只读数据库连接执行，不以 Admin JWT 或 Admin 接口权限为查询前提；缺少只读连接时说明实际连接缺口，不能改走 CLI。'
    + '只有本次确实需要执行 Admin 增删改或具有修改副作用的任务接口，并核实 CLI 支持该动作时，才使用 commands/admin.sh；按真实副作用而非 HTTP 方法判断。'
    + 'Admin 修改执行前必须按 AGENTS.md 的确认清单用列表说明地域、环境、对象归属及名称/ID、变更范围、变更前后和影响/恢复，再取得二次确认；'
    + '用户明确免除二次确认或给出最终授权时，仅在其授权范围内执行。';
  if (!env?.PALLAS_ADMIN_JWT || !env.PALLAS_ADMIN_API_BASE_URL) return routing;
  return routing + '\n本轮已注入真实飞书发送者的 Pallas Admin 身份 JWT，仅用于需要执行的 Admin 修改，接口权限由 Admin 实时判定。'
    + '修改调用必须根据本次目标显式传 --region 与 --environment，禁止猜测或使用默认地域/环境，'
    + '--base-url "$PALLAS_ADMIN_API_BASE_URL"；凭证从 PALLAS_ADMIN_JWT 环境变量读取。'
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
