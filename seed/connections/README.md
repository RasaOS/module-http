# `.claude/connections/` — this project's API connections

One folder per connection, named `^[a-z0-9-]+$`:

```
.claude/connections/github/connection.json   # the machine contract (unified connection spec)
.claude/connections/github/SKILL.md          # the operator knowledge (per-API skill)
```

`connection.json` declares hosts, auth (by secret NAME), operations, and
limits; `SKILL.md` teaches an agent to use the API well. Templates for
both live in `.claude/http/templates/`; run **`/api-onboard`** to stand a
new connection up end-to-end (spec → allowlist → auth env var named →
health probe → skill).

**The secrets rule (non-negotiable):** files in this directory carry
secret *names* only. Values live in env vars (`HTTP_AUTH_<HOST>`,
`{{secret:NAME}}` bindings) or the kernel vault — never in these files,
never committed, never pasted into chat.

This directory is project-owned — the http module never overwrites it on
upgrade.

**Promotion path:** a connection that proves itself here can graduate
into a typed connector Element (`content/connections/<name>/` inside its
own Element repo) under canon SA-031, gaining kernel-enforced allowlists
and call-time secret resolution. The spec shape is identical by design.
