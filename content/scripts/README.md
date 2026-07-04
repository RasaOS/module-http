# mcp-http-server.mjs

The portable MCP server that `rasa.module.http` ships: generic HTTP/REST
access for agents over stdio JSON-RPC. Node >= 18, single file, zero
dependencies — point any project's `.mcp.json` at it and it runs.
Tools: `http_request`, `http_get_json`, `http_paginate`, `http_capabilities`.

**Honesty tier.** Every guardrail here (allowlist, private-host block,
redaction, byte cap) is enforced *inside this process* — self-policing.
The enforced tier is the kernel-side HttpExecutor (canon SA-031: kernel
choke point, call-time secret resolution, DNS handled at the boundary).
There is **no DNS pinning** here: the private-host check is on the
hostname literal only. Once SA-031 lands, this module is dev-tenant/utility only.

## Env config

| Var | Default | Meaning |
|---|---|---|
| `HTTP_ALLOWED_HOSTS` | *(empty = ALL egress denied)* | Comma list. `*.suffix` wildcards; `*` = all **public** hosts. Private/loopback/link-local always denied unless the exact host is listed. |
| `HTTP_AUTH_<HOST>` | — | Full header line (`Authorization: Bearer x`) injected for that host when the caller didn't set it. Host sanitized: `api.github.com` → `HTTP_AUTH_API_GITHUB_COM`. **Names in config, values only in env — never in chat, files, or logs.** |
| `HTTP_TIMEOUT_MS` | `30000` | Default per-request timeout. |
| `HTTP_MAX_RESPONSE_BYTES` | `262144` | Hard response cap; overflow sets `truncated: true`. |
| `HTTP_CONNECTIONS_DIR` | `.claude/connections` | Scanned by `http_capabilities` for `*/connection.json` specs. |

## Envelopes

Success — `{ok:true, status, content_type, returned_bytes, truncated, body, note?}`.
HTTP 4xx/5xx are **data**, not failure (`ok:true` with the status);
429 adds `retry_after_ms`. `http_paginate` adds `pages_fetched` and a
merged-array `body`.

Error (policy/transport; MCP `isError: true`) —
`{ok:false, error:{code, message, retryable, retry_after_ms?, fix_hint}}`.

| Code | When |
|---|---|
| `invalid_args` | Bad URL/method/params. |
| `not_allowlisted` | Host not in `HTTP_ALLOWED_HOSTS` — `fix_hint` includes the current allowlist. |
| `private_host_blocked` | Loopback/private/link-local literal, not explicitly listed. |
| `missing_auth` | 401 with no credential sent or configured — `fix_hint` names the exact env var; do not retry, ask the operator. |
| `timeout` | AbortController fired (retryable). |
| `network_error` | DNS/TLS/reset, or >5 redirects (retryable). |

Redirects are followed manually (max 5) and **re-validated per hop**;
credentials are dropped on cross-host redirects and re-injected only if
the new host has its own `HTTP_AUTH_*`. Values injected from `HTTP_AUTH_*`
are scrubbed from every error message and audit line. Each call writes one
JSON audit line to stderr: `{"audit":"http_call", tool, host, method, path, status, bytes, ms}`
(path carries no query string). Stdout carries only JSON-RPC.

## Wiring into `.mcp.json`

Copy `content/templates/mcp-config.snippet.json` into your project's
`.mcp.json` and set the env block (allowlist + auth vars) there. Non-GET
calls against real services require explicit user intent — the skills in
this module confirm before writing; keep that discipline.

Smoke test:

```sh
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' | node content/scripts/mcp-http-server.mjs
```
