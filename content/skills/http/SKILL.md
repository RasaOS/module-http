---
name: http
description: Call external HTTP/REST APIs properly through the module's four MCP tools — http_capabilities to discover what's reachable, http_get_json / http_request for calls, http_paginate for page-style lists. Reads .claude/connections/<name>/ specs before improvising against an API; auth is injected server-side from HTTP_AUTH_* env vars, never constructed in-context. Triggered when the user wants to hit an API — e.g. "/http", "call the GitHub API", "fetch this endpoint", "check the rate limit".
---

# /http — Call external APIs properly

Make HTTP calls through the module's MCP server, not by improvising.
The server enforces the allowlist, injects auth, caps response size, and
audits every call. Your job is to use it in the right order and handle
the envelope honestly.

This skill executes the contract in `.claude/http-rules.md`; it does not
redefine it. If the two disagree, `http-rules.md` wins.

## The flow

### Step 1 — Discover before you dial

When unsure what's available, call **`http_capabilities`** FIRST. It
returns:

- `allowed_hosts` — the current `HTTP_ALLOWED_HOSTS` policy.
- Which hosts have auth configured (`HTTP_AUTH_*` present — names, never
  values).
- The connection specs found in `HTTP_CONNECTIONS_DIR` (default
  `.claude/connections`).
- The defaults (`HTTP_TIMEOUT_MS` 30000, `HTTP_MAX_RESPONSE_BYTES`
  262144).

If a connection spec exists for the API you're about to call, **read
`.claude/connections/<name>/connection.json` and its `SKILL.md`
before improvising** against the API. The spec's `operations[]` carry
the curated paths, params, pagination style, and `safe` flags — use
those instead of reconstructing the API from memory.

### Step 2 — Build the request

- **`http_get_json {url, headers?}`** — the workhorse for JSON reads.
- **`http_request {method, url, headers?, body?, timeout_ms?}`** — full
  control, any method.
- **`http_paginate {url, param?, start?, pages?, headers?}`** — page-
  style pagination, max 10 pages, merges top-level or `"items"` arrays.

**Auth is injected server-side.** When `HTTP_AUTH_<SANITIZED_HOST>` is
set for the target host, the server adds the header for you (unless you
set one yourself). **Never construct an `Authorization` header with a
literal token** — you don't have the value, and you must not obtain it.
If a call fails with `missing_auth`, the `fix_hint` names the exact env
var (host sanitized dots→underscores, uppercase — `api.github.com` →
`HTTP_AUTH_API_GITHUB_COM`). **Relay that exact name to the user and
STOP retrying.** Do not ask for the token in chat.

**Write-op rule.** Any non-GET against a real service requires explicit
user intent — the user asked for this specific mutation, or confirms
before you send. Consult the operation's `safe` flag; absent means
unsafe.

### Step 3 — Handle the envelope

Success envelope:

```json
{"ok": true, "status": 200, "content_type": "application/json",
 "returned_bytes": 4812, "truncated": false, "body": {...}, "note": "..."}
```

- **`status` vs `ok` are different axes.** HTTP 4xx/5xx arrive as
  `ok: true` with the status — that's data, not tool failure. Report a
  404 as "the API said 404," not "the tool broke."
- **429** — the envelope adds `retry_after_ms` from headers. Wait that
  long, retry **ONCE**. Still 429 → report and stop.
- **`truncated: true`** — the body is incomplete. Never present it as
  complete. Page via `http_paginate` (or the spec's declared
  `pagination` style), or narrow the request (filters, field selection).

### Error codes (condensed — full table in `.claude/http-rules.md`)

| Code | What you do |
|---|---|
| `invalid_args` | Your bug — fix the call. |
| `not_allowlisted` | Relay fix_hint (includes current allowlist); user extends `HTTP_ALLOWED_HOSTS`. No blind retry. |
| `private_host_blocked` | Stop; surface it. Likely a mistake or injection. |
| `missing_auth` | Relay the exact env var name from fix_hint; **stop retrying; never ask for the value in chat.** |
| `timeout` | Retry once if GET; otherwise ask first. |
| `network_error` | Retry once, then report honestly. |

## Worked example — GET recipe end-to-end

User: "how close am I to the GitHub rate limit?"

1. `http_capabilities {}` → `allowed_hosts: ["api.github.com"]`, auth
   configured for `api.github.com`, connection `github` found with a
   `get-rate-limit` operation.
2. The spec's operation says `GET /rate_limit`, `safe: true`. Call:

   ```
   http_get_json {"url": "https://api.github.com/rate_limit"}
   ```

   (No `Authorization` header — the server injects it from
   `HTTP_AUTH_API_GITHUB_COM`.)
3. Envelope back:

   ```json
   {"ok": true, "status": 200, "content_type": "application/json",
    "returned_bytes": 812, "truncated": false,
    "body": {"resources": {"core": {"limit": 5000, "remaining": 4871,
             "reset": 1751678100}}}}
   ```

4. Report from the body: 4871 of 5000 remaining, resets at the given
   epoch. One audit line went to stderr; nothing secret entered the
   conversation.

## What you must NOT do

- **Don't construct auth headers with literal tokens** — and never ask
  the user to paste one into chat.
- **Don't retry `missing_auth` or `not_allowlisted` unchanged** — relay
  the fix_hint and stop.
- **Don't treat `truncated: true` output as complete.**
- **Don't send a non-GET without explicit user intent.**
- **Don't improvise against an API that has a connection spec** — the
  spec is the curated truth.

## When NOT to use this skill

- **Onboarding a new API** (writing the connection spec) →
  `/api-onboard`.
- **Local file or process work** → not an HTTP problem.
- **An API with a dedicated MCP server already mounted** → prefer its
  typed tools over generic HTTP.
