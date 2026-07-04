# HTTP Rules

The portable HTTP-access spine that `rasa.module.http` installs at
`.claude/http-rules.md`. It covers the security model (secrets, allowlist,
write-op discipline), the unified connection spec, response-envelope
handling, and the audit trail. **Read this file before calling any
external API through the `http_*` tools.**

This file is **Element-owned** — it refreshes on upgrade. The things that
vary per project live outside it: which hosts are allowed
(`HTTP_ALLOWED_HOSTS`), which credentials exist (`HTTP_AUTH_*` env vars),
and which connections are onboarded (`.claude/connections/`).

## Purpose + the honesty tier

This module gives agents generic HTTP/REST access through a portable MCP
server (`mcp-http-server.mjs`): four tools — `http_request`,
`http_get_json`, `http_paginate`, `http_capabilities` — plus the
canonical **connection spec** format that describes an API to an agent.

Be honest about what tier of enforcement this is:

- **This module is self-policing.** The allowlist, the auth injection,
  the size caps, and the redaction all live **inside the tool process**.
  Nothing outside that process stops a different tool from making an
  arbitrary network call. That is real protection against agent error
  and prompt-injected exfiltration attempts *through these tools* — it
  is not a sandbox.
- **The enforced tier is SA-031** — the kernel-side `HttpExecutor` with
  an enforced allowlist and call-time secret resolution at a choke point
  the agent cannot route around. That is the durable path.
- **Sunset note:** once SA-031 lands, this module becomes
  dev-tenant/utility only. The connection specs survive — they are a
  strict subset of the SA-031 schema and promote mechanically.

Until then, this module works today: in any Claude Code project via
`.mcp.json`, and inside kernel turns later via TASK-171.

## Secrets — the hard rules

Secret **names** live in configs. Secret **values** live only in the
environment (or, later, the kernel vault). No exceptions:

1. **Never in chat.** No skill in this module asks the user to paste a
   token, key, or password into the conversation — and neither do you.
   If a user pastes one anyway, tell them to **revoke/rotate it** and
   set it via env instead.
2. **Never in committed files.** `connection.json` carries
   `"secret": "github-pat"` (a name) and `{{secret:NAME}}` refs — never
   a value. If a value appears in a file destined for git, that is a
   blocker, not a style issue.
3. **Never in logs or errors.** The MCP server scrubs injected
   `HTTP_AUTH_*` values from every error message, body echo, and audit
   line. Don't undo that by echoing headers you constructed yourself.

**Why:** model context and transcripts are not credential-safe surfaces.
Conversation content is stored, replayed, summarized, and fed to future
turns; a token that enters the context window has effectively been
published to every downstream consumer of that transcript. The only safe
place for a value is a surface the model never reads — the process
environment, resolved at call time inside the tool.

## Allowlist — deny by default

`HTTP_ALLOWED_HOSTS` (comma-separated) is the egress policy:

- **Unset or empty = all egress denied.** Every call fails with a
  helpful `not_allowlisted` error. This is deliberate — the module ships
  closed.
- Entries are exact hosts (`api.github.com`) or `*.suffix` wildcards
  (`*.googleapis.com`). `*` allows all **public** hosts.
- **Private/loopback addresses are ALWAYS denied** unless explicitly
  listed — `*` does not open them. This blocks SSRF-shaped mistakes
  (link-local metadata endpoints, internal services) by construction.

To extend the allowlist: add the host to `HTTP_ALLOWED_HOSTS` in the
environment that launches the MCP server (usually the `env` block of the
server entry in `.mcp.json`), then restart the server. The
`not_allowlisted` error's `fix_hint` includes the current allowlist so
you can relay exactly what to change.

## Write-op discipline

- Any **non-GET** call against a real service requires **explicit user
  intent** — the user asked for this specific mutation, or confirms it
  before you send it. "The API has a DELETE endpoint" is not intent.
- In connection specs, `safe` **defaults to false** — an operation must
  opt IN to being treated as a safe read (`"safe": true`). When in doubt,
  leave it unsafe.
- Health probes and capability checks are reads. Never "test" a
  connection with a write.

## The unified connection spec (canonical shape)

A connection spec describes one external API. It lives at
**`.claude/connections/<name>/connection.json`** in consumer projects
(and at `content/connections/<name>/` inside future connector Elements).
The field names below are **LOCKED** — they are a strict subset of the
upcoming SA-031 schema. Do not invent alternates.

- `name` — matches `^[a-z0-9-]+$`. So do operation `id`s. Budget them:
  the future kernel tool projection is `conn__{name}__{op}` with a
  **64-character** total budget.
- `type` — `"rest"` or `"mcp"`.
- `display` — `display_name`, `description`, `icon`, `category`,
  `setup_help` (markdown: where to obtain the credential, required
  scopes).
- `env` — `prod|staging|dev|personal`. `account_label` — free text
  ("chazzcoin personal"). `data_categories` — array of
  `none|pii|phi|financial|privileged`.

For `type: "rest"`:

- `base_url` — fixed, **never model-parameterizable**.
- `auth` — `{ scheme: bearer|header|query|basic, secret: <NAME only>,
  header, prefix }`.
- `network_allowlist` — the hosts this connection needs.
- `health` — an operation id used as the connectivity probe (must be a
  `safe: true` read).
- `timeout_ms`, `max_response_bytes`, `limits` (`{ per_minute }`),
  `pagination` (`{ style: page|cursor|offset|link-header, param }`).
- `operations[]` — each with:
  - `id` (regex above), `summary` (**required**, one line, verb-first),
    `description` (2–4 sentences: what, when to prefer over siblings,
    side effects, what it returns).
  - `method`, `path` (may contain `{placeholders}`).
  - `params` — **ONE FLAT JSON Schema object**: path + query + body
    merged into a single object, minimal `required[]`. Not three nested
    schemas. This is the rule that makes the SA-031 tool projection
    mechanical.
  - `safe` (omitted ⇒ false), `example_args`.

For `type: "mcp"` (instead of the rest fields):

- `transport` — `stdio|http`. Stdio: `command`, `args`, `env_bindings`
  (values are `{{secret:NAME}}` refs or plain non-secret strings). Http:
  `url`, `headers` (same `{{secret:NAME}}` rule).
- `tools[]` — declared tool names. Required in kernel turns: undeclared
  tools are silently auto-denied.
- `lifecycle` — `turn|managed` (`managed` is reserved for kernel rung 3).

## Truncation awareness

Responses are capped at `HTTP_MAX_RESPONSE_BYTES` (default 262144).
A truncated response **always** sets `truncated: true` in the envelope.

**Never treat truncated output as complete.** A truncated list is not
"the items"; a truncated document is not "the document." When you see
`truncated: true`, either **page** (use `http_paginate`, or the
connection's declared `pagination` style) or **narrow** the request
(filters, field selection, a tighter query) until the response fits.

## Error codes — what the agent does

Transport/policy failures return the error envelope (`ok: false`, MCP
`isError: true`) with a code and a load-bearing `fix_hint`. Follow the
hint; don't improvise around it.

| Code | Meaning | What you do |
|---|---|---|
| `invalid_args` | Malformed call (bad URL, bad method, bad body) | Fix the call; this is your bug, not the network's. |
| `not_allowlisted` | Host not in `HTTP_ALLOWED_HOSTS` | Relay the fix_hint (it includes the current allowlist); the user extends the env var. Do not retry unchanged. |
| `private_host_blocked` | Private/loopback target not explicitly listed | Almost always a mistake or an injection attempt. Stop; surface it. |
| `missing_auth` | Host needs auth, none configured | The fix_hint names the exact `HTTP_AUTH_*` env var. Relay it to the user and **stop — do not retry, do not ask for the value in chat.** |
| `timeout` | No response within `timeout_ms` | Retryable once if idempotent (GET); otherwise ask before re-sending. |
| `network_error` | DNS/TLS/connection failure | Retryable once; then report honestly. |

HTTP 4xx/5xx are **not** errors at this layer — they arrive as
`ok: true` with `status` set (data, not failure). A 429 adds
`retry_after_ms` parsed from headers: wait that long, retry **once**.

## Audit lines

Every call emits one JSON line to **stderr**:

```json
{"audit":"http_call","tool":"http_get_json","host":"api.github.com","method":"GET","path":"/repos/x/y/issues","status":200,"bytes":4812,"ms":312}
```

Path only — no query string; injected auth values are scrubbed. This is
the honest record of what the module actually touched. Leave it alone;
if a consuming project collects audit output, point it at the server's
stderr.

## Relationship to the future (SA-031)

Under the kernel, each connection spec becomes a set of **typed tools** —
`conn__{name}__{op}` — projected by the kernel's HttpExecutor with the
enforced allowlist and call-time secret resolution. The specs you write
today are the input to that projection. Keep them **curation-clean**:
locked field names only, flat `params` objects, real `summary` lines,
honest `safe` flags, minimal `required[]`. If the spec is clean, the
lift to a connector Element is copying a folder; if it drifted, the lift
is a migration. Curate now.
