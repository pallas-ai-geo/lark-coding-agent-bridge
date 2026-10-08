# Message-scoped Pallas Admin identity

Configure `adminAuthorization` on the running profile to inject the independently verified sender's identity on every IM message:

```json
{
  "issuerUrl": "https://feishu.pallasai.net",
  "adminUrl": "https://admin.pallasai.net",
  "machineAuth": "ip"
}
```

There is no broker JWT, D1 broker registration, fixed region/environment or Admin-membership preflight. IP mode needs no Admin credential in the parent environment. For Admin callers using Service Token authentication, configure `machineAuth: "service-token"`, `cfAccessClientId` and `cfAccessClientSecret`; the pair remains in the parent. The issuer canonical origin must have a path-specific Cloudflare Access application for `/bridge/authorize`, with a Bypass policy matching only the fixed server IP. Access verifies the actual source IP at the edge. The Worker additionally checks `MESSAGE_BRIDGE_IP_ALLOWLIST`, rejects Worker subrequests and alternate Workers hostnames. A client-provided IP header alone is not authentication.

The issuer uses its own Feishu credentials to retrieve the original message, verify sender, tenant, timestamp and bot mention, then query that sender's company mailbox and employee status. The caller's identity fields are consistency checks; no caller-provided mailbox is trusted. An active employee receives an identity JWT even without Admin membership. Admin verifies the signature, live lease and current account/role/environment/resource permissions on each request. An identity JWT never grants Admin permissions.

Each message starts one run. Different senders are never batched. Resuming the same Codex conversation starts a new run with a new environment snapshot. Profiles with automatic Admin identity force lark-cli bot-only identity, and inherited `PALLAS_ADMIN_*`/`BRIDGE_ADMIN_*` credentials are stripped before inserting the current token.

Pallas business reads, searches, lists, statistics, document exports and before/after mutation checks must use authorized readonly SQL against the owning database. Exports read existing records and produce local files; they do not qualify as Admin mutations. PostgreSQL uses `pallas-postgres`; Admin's own RBAC/audit data uses its D1 readonly entry. Do not run Admin CLI lookups or membership preflights for a read/export task. SQL access is governed by the authorized database connection, independently of Admin JWT permissions. Missing readonly access is reported as a database connection gap; it does not switch a query to Admin CLI/API. Both adapters receive this routing instruction even when no Admin JWT is present.

The agent receives only `PALLAS_ADMIN_JWT` and `PALLAS_ADMIN_API_BASE_URL`, the origin of a distinct loopback proxy for this run. No region/environment default is injected. Use `commands/admin.sh` only for an actual supported Admin mutation or a task endpoint with modifying side effects, with explicit `--region`, `--environment` and `--base-url "$PALLAS_ADMIN_API_BASE_URL"`. Offline CLI capability discovery may precede a mutation. Classify operations by side effects, not HTTP verbs.

The proxy supports `/api/developer/me` and `/api/developer/admin/*`; transport support is not a business-read routing rule. Non-readonly actions require a second confirmation with an itemized scope and before/after state unless the user explicitly waived confirmation or gave final authorization. Current Admin permissions govern Admin calls. Previously issued environment-bound JWTs retain their narrower scope until expiry; new message JWTs carry identity/message/run claims, not roles or fixed targets.

The parent renews a 60-second lease every 20 seconds. Completion/cancellation closes the proxy, aborts outstanding requests and requests revocation. Missed renewal stops the run; if the parent crashes, the remaining lease expires within 60 seconds. JWT hard lifetime is one hour, and a revoked/expired lease cannot be revived. Already accepted mutations are not rolled back.

Signing keys and Feishu app credentials remain in the issuer Worker. Cloudflare Access Service Auth for other Admin clients remains available alongside the fixed Bridge-IP rule. Card-click identity needs independent callback verification; this endpoint verifies the sender of a real IM message. Same-user unrestricted processes are not OS-isolated by environment injection.

Deployment is complete only after the Worker protocol and running profile are configured and automatic injection is verified. Publishing code alone does not enable an unconfigured profile.

2026-10-07 real-message correction: Feishu returned a bot mention as app_id and marked the message updated. The issuer accepts this application-typed mention and verifies the fetched sender of edited messages; edits do not change the identity JWT subject. Deleted/stale messages and other-app mentions remain denied. Bridge reports allowlisted issuance reasons instead of attributing signing failures to Admin membership.
