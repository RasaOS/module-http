---
name: api-onboard
description: Onboard a new external API as a connection spec — gather the facts, write .claude/connections/<name>/connection.json + SKILL.md from the templates, tell the user exactly which env vars to set (HTTP_ALLOWED_HOSTS, HTTP_AUTH_<SANITIZED_HOST>), then validate via http_capabilities + the health operation. SCAFFOLD-ONLY — never accepts credential values in chat. Triggered when the user wants to wire up an API — e.g. "/api-onboard", "add the Stripe API", "onboard this MCP server", "set up a connection to GitHub".
---

# /api-onboard — Onboard an API as a connection

Walk the user from "I want to use API X" to a validated
`.claude/connections/<name>/` folder: a `connection.json` in the locked
unified-spec shape, a per-connection `SKILL.md`, the env changes named
exactly, and a green health probe.

This skill executes the contract in `.claude/http-rules.md`; it does not
redefine it. The specs it writes are the exact shape SA-031 connector
Elements use — write them curation-clean.

## ⚠️ SCAFFOLD-ONLY — the hard rule

**This wizard NEVER accepts credential values in chat.** Not "just this
once," not "it's a test token," not into a file, not into an env command
you run for the user. Configs carry secret **names**; values go into the
environment out-of-band, by the user, from their secret store.

**If the user pastes a token into the conversation anyway: instruct them
to revoke/rotate it immediately** — a value that entered the transcript
is burned — **and set the replacement via env instead.** Then continue
the onboarding with the secret name only.

## The steps

### Step 1 — Gather the facts

Collect (ask compactly; batch the questions):

- **Display name** + one-line description; the docs URL.
- **`base_url`** — fixed; never model-parameterizable.
- **Auth**: scheme (`bearer|header|query|basic`), header name/prefix if
  non-standard, and the **secret NAME** (e.g. `github-pat`) — the name
  only.
- **`env`** — `prod|staging|dev|personal`; `account_label` free text.
- **`data_categories`** — `none|pii|phi|financial|privileged`. Be
  honest; this drives future policy.
- **The 3–8 operations that actually matter** — not the whole API
  surface. Per operation: `id` (`^[a-z0-9-]+$`; remember the
  `conn__{name}__{op}` 64-char budget), `summary` (required, verb-first
  one-liner), `method`, `path`, minimal `params` (ONE flat JSON Schema
  object — path + query + body merged, minimal `required[]`), `safe`
  flag (opt IN; omitted means false), `example_args`.
- **Pagination style** — `page|cursor|offset|link-header` + param.
- **`health`** — which operation is the connectivity probe. Must be a
  `safe: true` read.

The connection `name` matches `^[a-z0-9-]+$`.

### Step 2 — Write the files

Write **`.claude/connections/<name>/connection.json`** from the module's
**rest template** (`.claude/http/templates/connection.rest.json.template`),
using only the LOCKED field names from `.claude/http-rules.md`. Fill
`display.setup_help` with real markdown: where to obtain the credential,
which scopes it needs.

**Onboarding a published MCP server instead?** Use the **mcp template**
(`.claude/http/templates/connection.mcp.json.template`, `type: "mcp"`). Accept a pasted `claude_desktop_config`-style JSON
snippet as INPUT and convert it: `command`/`args` map across;
**rewrite any literal env secrets to `{{secret:NAME}}` refs** in
`env_bindings` — and tell the user to set the real value out-of-band
(and rotate it if the pasted snippet contained a live value: it just
entered the transcript). Declare `tools[]` (undeclared tools are
silently auto-denied in kernel turns) and `lifecycle: "turn"`
(`managed` is reserved for kernel rung 3).

Write **`.claude/connections/<name>/SKILL.md`** from the api-skill
template (`.claude/http/templates/api-skill.md.template`) — the
per-connection usage guide: which operation for which
job, the pagination pattern, the gotchas.

### Step 3 — Name the env changes exactly

Tell the user precisely what to update in the environment that launches
the MCP server (usually `.mcp.json`'s `env` block, sourcing values from
their shell env / secret store):

1. **Add the host(s) to `HTTP_ALLOWED_HOSTS`** — every host in the
   spec's `network_allowlist`. Unset/empty means all egress is denied,
   so this step is not optional.
2. **Set `HTTP_AUTH_<SANITIZED_HOST>`** — show the exact sanitized var
   name (dots→underscores, uppercase: `api.github.com` →
   `HTTP_AUTH_API_GITHUB_COM`). The value is the full header line (e.g.
   `Authorization: Bearer …`), sourced from their secret store or shell
   env — **you never see it, and it never appears in chat.**

Then the user restarts the MCP server so the env takes effect.

### Step 4 — Validate

1. Call `http_capabilities {}` — confirm the connection appears in the
   specs from `HTTP_CONNECTIONS_DIR` and the host shows auth
   **configured**.
2. Run the **health operation** (it must be a `safe: true` read — never
   validate with a write) and show the user the returned envelope:
   `ok`, `status`, `returned_bytes`, `truncated`.
3. `missing_auth` → relay the exact env var from the fix_hint and stop.
   `not_allowlisted` → relay the fix_hint's current allowlist; the user
   fixes `HTTP_ALLOWED_HOSTS`. Re-validate after they act.

### Step 5 — Closing note

Tell the user: this spec folder is the exact shape SA-031 connector
Elements use. **Promotion is copying `.claude/connections/<name>/` into
an Element's `content/connections/`** — nothing to rewrite, provided the
spec stayed curation-clean (locked field names, flat `params`, honest
`safe` flags, real summaries).

## What you must NOT do

- **Don't accept, request, or echo a credential value** — in chat, in a
  file, in a command. Names only. Pasted value → revoke/rotate + env.
- **Don't invent field names.** The spec shape is LOCKED; if a fact
  doesn't fit a locked field, it doesn't go in the spec.
- **Don't onboard the whole API.** 3–8 operations that matter; the rest
  can come later.
- **Don't mark an operation `safe: true` unless it is a genuine
  side-effect-free read.** Default is unsafe.
- **Don't validate with a write.** The health probe is a read.
- **Don't skip validation.** An unvalidated connection is a spec, not a
  connection.

## When NOT to use this skill

- **Just calling an already-onboarded API** → `/http`.
- **A one-off request against a host with no future** → `/http`
  directly; a spec is for APIs you'll return to.
- **Building the connector Element itself** → that's the SA-031 track;
  this skill produces its input.
