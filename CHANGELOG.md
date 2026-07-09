# CHANGELOG — `rasa.module.http`

Reverse-chronological. Each entry is a version bump.

---

## 0.1.3 — 2026-07-09

### Element identity layer (canon SA-025)

- Added `rasa.identity` ("the RasaOS module for HTTP"); `bin/init` generates `.claude/rasa-identity.md` from it every install + stamps project-owned `.claude/rasa-deployment.md`; ships `/whoami`; CLAUDE.md "Who you are" header.

## 0.1.2 — 2026-07-09

### Added generic `/sync` + `/promote` + `/kit`-aware `bin/init` (canon SA-024)

- `bin/init` now clones the Element source into `<project>/kit/<element>/`; `/sync` smart-pulls upstream, `/promote` smart-pushes local edits back upstream (both directory-mirror → installed into consumers).

## 0.1.1 — 2026-07-09

### `parent_kind` → `[domain, tenant]` (canon SA-023)

- The `orchestrator` kind was folded into `tenant`; this module now mounts into a tenant or a domain (`requires.parent_kind: ["domain", "tenant"]`, was `["domain", "orchestrator"]`).

## 0.1.0 — 2026-07-04 — INITIAL

**Seventh module; rung-1 opener of the Connections track.** Generic
HTTP/REST access for agents: a portable zero-dependency MCP server, the
unified connection-spec convention, and the skills that onboard and
drive real APIs. Works today in any Claude Code project via `.mcp.json`;
runs inside kernel turns later via TASK-171.

### What it is

- **Kind:** `module` (canon Spec §6) — opt-in, mountable into a parent
  `domain` or `orchestrator` via the parent's `requires.elements[]`.
  `requires.parent_kind: [domain, orchestrator]`.
- **Contract:** Element Contract v1.3.0.

### What ships

- **The server** — `content/scripts/mcp-http-server.mjs` (Node stdlib
  only, installs to `.claude/http/`). Four tools: `http_request`,
  `http_get_json`, `http_paginate` (page-style, ≤ 10 pages),
  `http_capabilities`. Honest envelopes: HTTP 4xx/5xx are data
  (`ok:true` + status); transport/policy failures are `ok:false` with a
  machine-readable `code` + load-bearing `fix_hint`. Deny-by-default
  allowlist (`HTTP_ALLOWED_HOSTS`; private/loopback always denied unless
  listed), per-host auth injection (`HTTP_AUTH_<SANITIZED_HOST>` full
  header lines), byte caps with explicit `truncated:true`, credential
  redaction across errors/bodies/audit, one JSON audit line per call to
  stderr.
- **The rules spine** — `content/http-rules.md` →
  `.claude/http-rules.md`: secrets are names-in-configs /
  values-in-env-or-vault (never in chat, never committed, never echoed);
  write-op discipline (non-GET against real services requires explicit
  user intent); the honesty-tier statement.
- **The unified connection spec** — `.claude/connections/<name>/`
  (`connection.json` + per-API `SKILL.md`), field names locked as a
  strict subset of the upcoming SA-031 schema; names/op ids
  `^[a-z0-9-]+$` (64-char `conn__{name}__{op}` projection budget).
  Worked templates: `connection.rest.json.template` (GitHub, 3 ops incl.
  one `safe:false` write), `connection.mcp.json.template` (stdio +
  `{{secret:}}` bindings + declared `tools[]` + http-transport variant),
  `api-skill.md.template` (9-section checklist),
  `mcp-config.snippet.json` (the `.mcp.json` entry).
- **Skills** — `/api-onboard` (spec → allowlist → auth env var named →
  health probe → skill), `/http` (ad-hoc calls under the spine).

### Install shape

- **Element-owned (`element.files[]`, refreshed on upgrade):**
  `http-rules.md` → `.claude/`, `skills/` → `.claude/skills/`,
  `scripts/` → `.claude/http/`, `templates/` → `.claude/http/templates/`.
- **Project-owned (`seed.files[]`):** `.claude/connections/README.md`
  (`skip-if-exists`) and the stamped `rasa.lock.json`.

### Two debts, stated honestly

1. **Enforcement is self-policing.** The allowlist, auth injection, and
   redaction run inside the same tool process the model calls — real
   protection against mistakes, **not a security boundary**. Nothing
   outside the process verifies the policy. The enforced tier is canon
   SA-031's kernel-side HttpExecutor (choke-point allowlist).
2. **Rung-1 secret materialization.** Under the kernel (TASK-171),
   `HTTP_AUTH_*` / `{{secret:}}` values are materialized into the server
   process env at spawn time — secrets sit in env for the turn's
   lifetime rather than being resolved at call time from the vault.
   Call-time resolution is SA-031's job; this module does not pretend to
   have it.

### Sunset clause

When SA-031 lands (typed connector Elements + kernel HttpExecutor),
`rasa.module.http` becomes a **dev-tenant / utility Element** — the
quick generic-HTTP tool for development and one-off APIs — and typed
connectors become the production path. The connection spec is a strict
subset of SA-031's schema precisely so specs authored under this module
promote without rewrites. By design, not by failure.

### Provenance / decisions

- Canon context: SA-020 (triage) — MCP-server declaration on Elements —
  is what this module's mcp-type specs anticipate project-locally;
  SA-031 (pending) is the Connections-track amendment this module opens
  the ladder for.
- **Boundary decision:** no plumbing beyond HTTP — no OAuth dance
  automation, no vault implementation, no long-lived (`managed`)
  MCP server lifecycle; `lifecycle: "managed"` is reserved for the
  kernel (rung 3).
