# CLAUDE.md — `rasa.module.http`

> **Who you are (SA-025).** `rasa.module.http` — the RasaOS module for HTTP. Substrate: **RasaOS**; role: **module**. On install `bin/init` renders this into `.claude/rasa-identity.md`; `/whoami` composes the full identity with the project's deployment layer.


Per-repo working contract for Claude sessions opened inside this folder.
Extends `~/.claude/CLAUDE.md` and the workspace `~/rAI/rasa-os/CLAUDE.md`
(the `rasa.tenant.rasaos` tenant's contract); does not override them.

## What you are when you're in this folder

You are working on **`rasa.module.http`** — a `module`-kind Element:
generic HTTP/REST access for agents. A portable zero-dependency MCP
server (`http_request`, `http_get_json`, `http_paginate`,
`http_capabilities`), the unified `connection.json` spec + templates,
and the `/http` + `/api-onboard` skills. It is the **seventh module**
and the **rung-1 opener of the Connections track**: it works today in
any Claude Code project via `.mcp.json`, and inside kernel turns later
via TASK-171. The durable path is canon SA-031's kernel-side
HttpExecutor; see "Sunset + honesty" below.

## Layout

- `content/http-rules.md` — the spine every consumer installs at
  `.claude/http-rules.md`.
- `content/scripts/mcp-http-server.mjs` — the server. Installs to
  `.claude/http/`.
- `content/skills/{http,api-onboard}/` — installs to `.claude/skills/`.
- `content/templates/` — connection.rest / connection.mcp / api-skill /
  mcp-config templates. Installs to `.claude/http/templates/`.
- `seed/connections/README.md` — seeds `.claude/connections/`
  (skip-if-exists; the directory is project-owned forever).
- `rasa.json` — the formal declaration + install manifest.

## Conventions (load-bearing)

- **Spec-locked field names.** The connection spec is a strict subset of
  the upcoming SA-031 schema. Do not rename fields, do not invent
  alternates, do not add fields casually — additions here must stay a
  subset of what SA-031 adopts, or promotion breaks.
- **Naming regex.** Connection names and operation ids match
  `^[a-z0-9-]+$`. The future tool projection `conn__{name}__{op}` has a
  64-character budget — keep both segments short and check the sum when
  authoring examples.
- **Zero-dep server.** `mcp-http-server.mjs` uses the Node stdlib only
  (Node ≥ 18, global `fetch`). No `package.json`, no `node_modules`,
  ever — the whole point is that one file copies anywhere and runs.
- **Stdout purity.** Stdout is the MCP stdio transport. Nothing writes
  to stdout except JSON-RPC frames — logging, audit lines, debug all go
  to stderr. One stray `console.log` bricks the server for every
  consumer.

## How to test the server

No test framework; drive it over stdio directly:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"driver","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"http_capabilities","arguments":{}}}' \
  | HTTP_ALLOWED_HOSTS=api.github.com node content/scripts/mcp-http-server.mjs
```

Swap the `tools/call` line to exercise other tools. Verify the three
behaviors that matter every time you touch the server: deny-by-default
(run with `HTTP_ALLOWED_HOSTS` unset → `not_allowlisted` with the empty
allowlist in `fix_hint`), redaction (set a fake `HTTP_AUTH_*`, force an
error, confirm the value appears nowhere in output), and stdout purity
(stderr may chatter; stdout is frames only).

## Sunset + honesty (restate in any copy you write)

Enforcement in this module lives **inside the tool process** —
self-policing, and said plainly everywhere: real protection against
mistakes, not a security boundary. The enforced tier is SA-031's kernel
HttpExecutor (choke-point allowlist, call-time secret resolution). Once
SA-031 lands, this module is dev-tenant/utility only — that sunset is
written into the README and CHANGELOG; don't soften it in future copy.

## Don'ts

- **Never add dependencies to the server.** Stdlib only. A dependency
  defeats portability and widens the audit surface of the one file that
  handles credentials.
- **Never weaken deny-by-default.** `HTTP_ALLOWED_HOSTS` unset/empty =
  all egress denied; private/loopback denied unless explicitly listed.
  No "convenience" defaults, no allow-on-missing-config.
- **Never accept tokens in chat — in any skill copy.** Skills name the
  env var / vault entry and tell the operator to set it out of band.
  If a draft skill says "paste your token", it's wrong.
- **Don't drift the spec.** Field names, enums, and the naming regex are
  locked; changes go through the SA-031 canon task, not this repo.
- **Don't harden soft references.** Connection specs may mention sibling
  modules or Elements; nothing here gains a hard `requires.elements[]`
  on them.
- **Don't `bin/init` this Element into itself.** `content/` is the
  source (workspace rule).
- **Don't push to GitHub from the Cowork sandbox.** Local commit + tag;
  the user pushes (workspace rule).

## How a version bump works

Each bump: edit `VERSION` + `rasa.json#version`, write a CHANGELOG
entry, run `bin/check-manifest`, re-run the stdio driver above, commit +
tag `v<version>`. Update `~/rAI/rasa-os/elements/REGISTRY.md` +
`~/rAI/rasa-os/elements/CHANGELOG.md` (track #2).

## What success looks like

- Any Claude Code project can install this module, merge one `.mcp.json`
  snippet, set two env vars, and make its first governed API call in
  under five minutes — with zero secrets in files or chat.
- A connection authored here promotes into an SA-031 typed connector
  Element without a field rename — the spec proving itself upward.
