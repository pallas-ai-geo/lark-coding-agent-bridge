# Message-scoped Pallas Admin authorization

An opt-in profile can obtain one independently verified Admin identity per IM message. This feature does not mint Cloudflare Access user tokens locally.

Configure `adminAuthorization` on the profile:

```json
{
  "issuerUrl": "https://feishu.pallasai.net",
  "adminUrl": "https://admin.pallasai.net",
  "bridgeSecret": { "source": "env", "id": "BRIDGE_ADMIN_ISSUER_SECRET" },
  "machineAuth": "ip",
  "region": "domestic",
  "environment": "test"
}
```

IP mode does not resolve or send CF service credentials. The server environment file contains only `BRIDGE_ADMIN_ISSUER_SECRET`. To retain the original client behavior, omit `machineAuth` or set it to `service-token` and configure both `cfAccessClientId` and `cfAccessClientSecret`. Mixed or partial credentials are rejected.

Keep secret values out of profile JSON. Existing file/exec secret references also work. Environment references for this feature must start with `BRIDGE_ADMIN_`; these and stale `PALLAS_ADMIN_*` values are excluded from all spawned agent environments.

The issuer uses its own Feishu credentials to verify message sender, tenant, recent timestamp, active employment, mailbox and bot mention. The caller-supplied sender is only a consistency check. The mailbox is checked against Admin's existing roles/environment before agent spawn. Missing permission or verification failure rejects the run, without a privileged fallback.

The public Admin entry points are `/api/developer/me` for the permission preflight and `/api/developer/admin/*` for the existing `/api/admin/*` APIs. The dedicated Cloudflare Access application keeps its Service Auth policy for other clients. In IP mode, add a separate Bypass policy matching only the fixed Bridge egress IP (`35.189.2.80/32`); Admin also verifies the edge-supplied IP and still requires the signed message token and live lease. Issuer endpoints remain `/bridge/authorize`, `/bridge/jwks`, `/bridge/introspect` and `/bridge/leases/*`.

Each authorized message starts one run. Different senders are never combined into a batch. The same Codex conversation can be resumed, but a new run receives a new environment snapshot and credential. Authorized profiles force lark-cli bot-only identity to avoid inheriting the owner's personal user token.

The agent receives `PALLAS_ADMIN_JWT`, `PALLAS_ADMIN_API_BASE_URL`, `PALLAS_ADMIN_REGION` and `PALLAS_ADMIN_ENVIRONMENT`. The API base is a random, loopback-only proxy for that run. Cloudflare service credentials and lease-management credentials remain in the bridge parent, not in the agent environment.

```bash
curl --fail-with-body -H "Authorization: Bearer $PALLAS_ADMIN_JWT" \
  "$PALLAS_ADMIN_API_BASE_URL/admin/groups"
```

The parent renews a 60-second lease every 20 seconds. Completion/cancellation closes the proxy and requests revocation. A missed renewal stops the agent; a crashed bridge or unreachable revocation endpoint leaves at most the remainder of the 60-second lease. JWT hard lifetime is one hour. A lease cannot be renewed after expiry/revocation. API requests recheck the lease and live Admin roles; already accepted mutations are not rolled back.

This is not OS-level isolation. A same-user, unrestricted process can inspect shared files/processes; deploy dedicated users/sandboxes if those processes are untrusted. IM message verification cannot prove that a compromised bridge follows the requested operation. Card-click authorization is not supported by this endpoint: it requires independent verification of the click callback, rather than querying the original card message.

Both remote Workers and a path-specific Cloudflare Service Auth application must be configured before enabling the profile. Do not copy the OIDC signing private key into the bridge. Use the new issuer's separate message keypair.
