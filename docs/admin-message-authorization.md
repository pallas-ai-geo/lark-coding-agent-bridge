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

The agent receives `PALLAS_ADMIN_JWT` and `PALLAS_ADMIN_API_BASE_URL` only through its run environment. The latter is the origin of a distinct loopback proxy for this run. No region/environment default is injected. The proxy supports `/api/developer/me` and `/api/developer/admin/*`, passes explicit target headers through and rejects missing or unsupported targets.

SQL/CLI routing, export behavior and mutation-confirmation requirements belong to the target workspace's `AGENTS.md` and skills. Bridge does not prepend or append product-specific business instructions to agent prompts. The adapters retain only the generic channel runtime conventions; enabling message credentials does not add a product policy prompt.

The verified issuer email and the current message sender ID/display name are included as structured `message_sender` data in the user prompt, refreshed for every run, including replies that resume a shared thread. Display name is included when available from the current message. This block contains no JWT, system instructions, roles or permissions; absent credentials do not reuse a previous sender. JSON/XML delimiters in display names are escaped.

Current Admin permissions govern Admin calls. Previously issued environment-bound JWTs retain their narrower scope until expiry; new message JWTs carry identity/message/run claims, not roles or fixed targets.

The parent renews a 60-second lease every 20 seconds. Completion/cancellation closes the proxy, aborts outstanding requests and requests revocation. Missed renewal stops the run; if the parent crashes, the remaining lease expires within 60 seconds. JWT hard lifetime is one hour, and a revoked/expired lease cannot be revived. Already accepted mutations are not rolled back.

Signing keys and Feishu app credentials remain in the issuer Worker. Cloudflare Access Service Auth for other Admin clients remains available alongside the fixed Bridge-IP rule. Card-click identity needs independent callback verification; this endpoint verifies the sender of a real IM message. Same-user unrestricted processes are not OS-isolated by environment injection.

Deployment is complete only after the Worker protocol and running profile are configured and automatic injection is verified. Publishing code alone does not enable an unconfigured profile.

2026-10-07 real-message correction: Feishu returned a bot mention as app_id and marked the message updated. The issuer accepts this application-typed mention and verifies the fetched sender of edited messages; edits do not change the identity JWT subject. Deleted/stale messages and other-app mentions remain denied. Bridge reports allowlisted issuance reasons instead of attributing signing failures to Admin membership.
