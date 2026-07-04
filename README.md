# RasaOS Module · Http

**Canonical name:** `rasa.module.http`
**Repo / folder:** `module-http`
**Kind:** `module` (canon Spec §6 — *a focused capability that extends a domain or orchestrator, mountable into one or more parents*)
**Contract:** Element Contract v1.3.0
**Version:** 0.1.0
**Status:** Live. Rung-1 opener of the Connections track; carries a written sunset (below).

## What this is

Generic HTTP/REST access for agents. A portable, zero-dependency MCP
server that any Claude Code project enables via `.mcp.json` — and that
kernel turns will run via TASK-171 — plus the **unified connection
spec**: the `connection.json` convention that describes an API once
(hosts, auth by secret name, operations, limits) and later graduates
into typed connector Elements under canon SA-031.

```
.claude/connections/<name>/connection.json  →  mcp-http-server.mjs  →  the API
        (the contract: WHAT may be called)      (allowlist + auth        (allowlisted
                                                 injection + envelope)     hosts only)
```

## The four tools

| Tool | Does |
|---|---|
| `http_request` | `{method, url, headers?, body?, timeout_ms?}` — the general verb |
| `http_get_json` | GET + parse JSON — the common case, minus ceremony |
| `http_paginate` | Page-style pagination (max 10 pages), merges result arrays |
| `http_capabilities` | What THIS process can reach: allowed hosts, auth-configured hosts, discovered connection specs, defaults |

Every call returns an honest envelope. HTTP 4xx/5xx are **data**
(`ok:true` with the status — a 404 is an answer, not a tool failure);
transport/policy failures are `ok:false` with a machine-readable `code`
and a load-bearing `fix_hint` (`not_allowlisted` includes the current
allowlist; `missing_auth` names the exact env var and says "ask the
operator — do not retry"). Injected credentials are scrubbed from every
error, body echo, and audit line.

## Quickstart

```sh
# 1. Install into your project (copies content/ + seed/ per rasa.json)
~/rAI/rasa-os/elements/module-http/bin/init <your-project>

# 2. Merge the server entry into your project's .mcp.json
#    (template at .claude/http/templates/mcp-config.snippet.json)

# 3. Set two env vars in the shell you launch Claude Code from
export HTTP_ALLOWED_HOSTS="api.github.com"
export GITHUB_TOKEN="<your PAT>"        # expanded into HTTP_AUTH_API_GITHUB_COM by the snippet

# 4. Restart Claude Code; first call
#    http_capabilities {}                → confirms the allowlist + auth wiring
#    http_get_json {"url": "https://api.github.com/rate_limit"}
```

`HTTP_ALLOWED_HOSTS` is **deny-by-default**: unset or empty means all
egress is denied with a helpful error. Wildcards `*.suffix` are
supported; `*` allows all public hosts; private/loopback addresses are
always denied unless explicitly listed.

## The honesty tier — and the sunset

Read this plainly: the allowlist, auth injection, byte caps, and
redaction are enforced **inside the tool process**. That is real
protection against mistakes and drift, but it is *self-policing* — the
same process the model talks to is the process doing the policing.
The enforced tier is canon SA-031's kernel-side **HttpExecutor**: the
allowlist checked at a choke point the tool can't reach around, secrets
resolved at call time from the vault instead of materialized into env.

**Sunset clause:** once SA-031 lands, this module becomes a dev-tenant /
utility Element — the quick generic-HTTP tool for development and
one-off APIs — and typed connector Elements become the production path.
That is by design, not by failure.

## The connection spec convention

A connection lives at `.claude/connections/<name>/` — `connection.json`
(the machine contract) + `SKILL.md` (the operator knowledge). Field
names are locked as a strict subset of the upcoming SA-031 schema, so a
spec authored today promotes into a connector Element without rewrites.
Names and operation ids match `^[a-z0-9-]+$` (the future
`conn__{name}__{op}` tool projection has a 64-char budget). Secrets
appear as **names only** — values live in env / the kernel vault, never
in files, never in chat. Worked templates (rest + mcp + the per-API
skill) ship in `content/templates/`; `/api-onboard` drives the whole
flow.

## Relationship to SA-020 / SA-031

Canon context, plain ids: **SA-020** (triage) is the MCP-server
declaration on Elements — how an Element tells the kernel "run this MCP
server for my turns" (the `--mcp-config` source; TASK-171 is the kernel
side). This module's mcp-type connection specs are that declaration's
project-local precursor. **SA-031** (pending) is the Connections-track
amendment proper: the typed connector Element kind + the kernel
HttpExecutor. This module is rung 1 of that ladder — it proves the spec
shape and the agent workflow now, in any Claude Code project, and hands
the enforcement problem to the kernel where it belongs.

## Layout

- `content/http-rules.md` — the HTTP-access spine (Element-owned).
- `content/scripts/mcp-http-server.mjs` — the server (zero-dep, Node stdlib only).
- `content/skills/` — `/http`, `/api-onboard`.
- `content/templates/` — connection.rest / connection.mcp / api-skill / mcp-config templates.
- `seed/connections/README.md` — seeds the project-owned `.claude/connections/`.
- `bin/init`, `bin/check-manifest` — the canonical installer + manifest checker.

## See also

- [`content/README.md`](content/README.md) — the full file-by-file install map.
- `~/rAI/rasa-os/elements/module-tasks/` — the first module; the shape this follows.
- `~/rAI/rasa-os/canon/tasks/triage/SA-020-mcp-server-element-declaration.md`.
- `~/rAI/rasa-os/elements/REGISTRY.md` — live Element registry.
