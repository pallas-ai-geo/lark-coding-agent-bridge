# Message-scoped Pallas Admin authorization

An opt-in profile can obtain one independently verified Admin identity per IM message. This feature does not mint Cloudflare Access user tokens locally.

Configure `adminAuthorization` on the profile:

```json
{
  "issuerUrl": "https://feishu.pallasai.net",
  "adminUrl": "https://admin.pallasai.net",
  "bridgeSecret": { "source": "env", "id": "BRIDGE_ADMIN_ISSUER_SECRET" },
  "cfAccessClientId": "<dedicated Cloudflare Service Token Client ID>",
  "cfAccessClientSecret": { "source": "env", "id": "BRIDGE_ADMIN_CF_SECRET" },
  "region": "domestic",
  "environment": "test"
}
```

Keep secret values out of profile JSON. Existing file/exec secret references also work. Environment references for this feature must start with `BRIDGE_ADMIN_`; these and stale `PALLAS_ADMIN_*` values are excluded from all spawned agent environments.

The issuer uses its own Feishu credentials to verify message sender, tenant, recent timestamp, active employment, mailbox and bot mention. The caller-supplied sender is only a consistency check. The mailbox is checked against Admin's existing roles/environment before agent spawn. Missing permission or verification failure rejects the run, without a privileged fallback.

Each authorized message starts one run. Different senders are never combined into a batch. The same Codex conversation can be resumed, but a new run receives a new environment snapshot and credential. Authorized profiles force lark-cli bot-only identity to avoid inheriting the owner's personal user token.

The agent receives `PALLAS_ADMIN_JWT`, `PALLAS_ADMIN_API_BASE_URL`, `PALLAS_ADMIN_REGION` and `PALLAS_ADMIN_ENVIRONMENT`. The API base is a random, loopback-only proxy for that run. Cloudflare service credentials and lease-management credentials remain in the bridge parent, not in the agent environment.

```bash
curl --fail-with-body -H "Authorization: Bearer $PALLAS_ADMIN_JWT" \
  "$PALLAS_ADMIN_API_BASE_URL/admin/groups"
```

The parent renews a 60-second lease every 20 seconds. Completion/cancellation closes the proxy and requests revocation. A missed renewal stops the agent; a crashed bridge or unreachable revocation endpoint leaves at most the remainder of the 60-second lease. JWT hard lifetime is one hour. A lease cannot be renewed after expiry/revocation. API requests recheck the lease and live Admin roles; already accepted mutations are not rolled back.

This is not OS-level isolation. A same-user, unrestricted process can inspect shared files/processes; deploy dedicated users/sandboxes if those processes are untrusted. IM message verification cannot prove that a compromised bridge follows the requested operation. Card-click authorization is not supported by this endpoint: it requires independent verification of the click callback, rather than querying the original card message.

Both remote Workers and a path-specific Cloudflare Service Auth application must be configured before enabling the profile. Do not copy the OIDC signing private key into the bridge. Use the new issuer's separate message keypair.
