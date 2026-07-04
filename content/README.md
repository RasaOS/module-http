# `rasa.module.http` — content

This is what the module ships: generic HTTP/REST access for agents. A
zero-dependency MCP server exposing four tools, the rules spine that
governs how agents use them, the unified connection-spec templates, and
the skills that onboard and drive real APIs. The rung-1 opener of the
Connections track — self-policing today, superseded by the kernel's
enforced HttpExecutor when SA-031 lands.

## What installs where

| Source | Installs to | Policy | Owner |
|---|---|---|---|
| `content/http-rules.md` | `.claude/http-rules.md` | file-replace | Element (refreshed on upgrade) |
| `content/skills/` | `.claude/skills/` | directory-mirror | Element |
| `content/scripts/` | `.claude/http/` | directory-mirror | Element (`mcp-http-server.mjs` lives here) |
| `content/templates/` | `.claude/http/templates/` | directory-mirror | Element |
| `seed/connections/README.md` | `.claude/connections/README.md` | skip-if-exists | **Project** (the connections dir is yours) |
| `seed/rasa.lock.json.template` | `.claude/rasa.lock.json` | init-only-with-sha | Project |

## The split that makes it portable

- **Element-owned (`content/`)** — the server, the four tools, the rules
  spine, the spec templates, the skills. Identical for every project;
  upgrades flow in.
- **Project-owned (`.claude/connections/`)** — one folder per connection
  (`connection.json` + `SKILL.md`), authored per project via
  `/api-onboard`. Never overwritten on upgrade. Plus the `.mcp.json`
  entry and the env vars — both live outside this Element entirely.

## The four tools

- **`http_request`** — the general verb: `{method, url, headers?, body?,
  timeout_ms?}` against an allowlisted host.
- **`http_get_json`** — the common case, minus ceremony: GET, parse JSON.
- **`http_paginate`** — page-style pagination (`param`, `start`,
  `pages` ≤ 10), merges top-level or `items` arrays.
- **`http_capabilities`** — what this process can actually reach: allowed
  hosts, which hosts have auth configured, connection specs found in
  `HTTP_CONNECTIONS_DIR`, defaults. Call it first; never guess.

Every call returns an honest envelope: `{ok:true, status, content_type,
returned_bytes, truncated, body}` — HTTP 4xx/5xx are **data**
(`ok:true` with the status), not tool failures. Transport and policy
failures return `{ok:false, error:{code, message, retryable, fix_hint}}`
with a load-bearing `fix_hint`.

## Hard rules (restated from `http-rules.md`)

- **Secrets: names in configs, values only in env / the kernel vault.**
  Never in chat, never in committed files, never echoed in logs or
  errors. Skills must never ask the user to paste a token.
- **Deny-by-default.** `HTTP_ALLOWED_HOSTS` unset or empty = all egress
  denied with a helpful error. Private/loopback hosts are always denied
  unless explicitly listed.
- **Write-op discipline.** Non-GET calls against real services require
  explicit user intent.
- **Honesty tier.** Enforcement lives inside the tool process —
  self-policing, stated plainly. The enforced tier is the kernel choke
  point (SA-031).

## Skills

- **`/api-onboard`** — stand up a new connection end-to-end: spec from
  the template, allowlist + auth env vars named (values set by the
  operator, out of band), health probe, per-API `SKILL.md`.
- **`/http`** — drive ad-hoc HTTP work through the four tools under the
  rules spine.

## Templates (`.claude/http/templates/` after install)

- `connection.rest.json.template` — worked rest-type spec (GitHub, 3
  operations incl. one `safe:false` write).
- `connection.mcp.json.template` — worked mcp-type spec (stdio via npx,
  `{{secret:}}` bindings, declared `tools[]`, plus the http-transport
  variant).
- `api-skill.md.template` — the 9-section per-API SKILL.md checklist.
- `mcp-config.snippet.json` — the `.mcp.json` entry that enables the
  server in Claude Code.

## Mounting into a parent

`rasa.module.http` is a `module` (canon Spec §6): a focused capability
mountable into a parent `domain` or `orchestrator`. A parent opts in via
its own `rasa.json`:

```json
"requires": {
  "elements": [
    { "name": "rasa.module.http", "version": ">=0.1.0" }
  ]
}
```

## See also

- `content/http-rules.md` — the spine (the contract).
- `../README.md` — module overview, quickstart, the sunset clause.
- Canon SA-020 (triage) — MCP-server declaration on Elements; SA-031
  (pending) — typed connectors + the kernel HttpExecutor that supersede
  this module's self-policing tier.
