---
name: promote
description: Smart-promote a local improvement to installed Element content back to the Element's upstream source, using the project's `/kit/<element>/` clone as the staging ground. Detects drift in Element-managed files since the pin, classifies each as portable improvement / project-specific override / mistaken edit, stages the portable ones into the /kit clone on a branch, and opens a PR (or prints exact manual steps) to the Element's repo. Never pushes without confirmation; never auto-commits in the project. Closes the upstream↔project loop. Triggered when the user has improved something in `.claude/` and wants it to flow back — e.g. "/promote", "push this back to the element", "this fix belongs upstream", "contribute this skill".
---

# /promote — Smart-push local improvements back upstream (via /kit)

Take a local edit to an Element-managed file and turn it into a PR on the
Element's upstream repo. The Element only improves when real-world fixes flow
back; this is the path. The reverse of `/sync`.

The staging ground is the project's **`/kit/<element>/`** clone — the same
fresh clone `/sync` reads from. `/promote` lands your local edit in that clone
on a branch and pushes it upstream; your project's `.claude/` is never the
thing that gets pushed.

Blunt about whether an edit is genuinely portable: some local changes belong
in the project's `CLAUDE.md` forever, not upstream. Don't push project-specific
quirks.

## Behavior contract

- **Read `.claude/rasa.lock.json` first.** It names the Element (`repo`,
  `branch`), the `pinned_sha`, and the `overrides[]`. If absent, this project
  wasn't installed from a rasa Element — stop.
- **The `/kit/<element>/` clone is the staging ground.** Locate it at
  `<project>/kit/<element>/`; clone fresh from `rasa.lock.json#repo` if absent.
  Everything is staged and pushed from there — never from the consumer project.
- **Detect drift, don't infer it.** For each Element-managed file
  (`rasa.json#element.files[]`), compare the local `.claude/<to>` against the
  pinned version (`git -C kit/<element> show <pinned_sha>:<from>`). Drift = real
  bytes-different.
- **Classify every drifted file with the user:**
  - **Portable improvement** — applies generally; promote it upstream.
  - **Project-specific override** — useful here, not generally; add to
    `overrides[]` in `rasa.lock.json`, leave in place, don't push.
  - **Mistaken edit** — meant for a project-owned file, not an Element-managed
    one; revert locally.
  - **Both-diverged** (local ≠ pinned AND upstream ≠ pinned) → ask the user to
    `/sync` first; `/promote` doesn't merge.
- **Group by theme into one or more PRs.** A branch that fixes a typo + adds a
  skill + tightens a rule is three PRs. Ask before splitting.
- **Never push without confirmation.** Show the branch name, PR title, body,
  and file list. Push + open the PR only on explicit go. If GitHub tooling
  (`gh`) is unavailable, print the exact manual `git`/PR steps instead.
- **Never auto-commit in the project.** Any `rasa.lock.json` edits (new
  `overrides[]` entries) are staged in the working tree, uncommitted.
- **Honest about uncertainty.** If the user can't tell whether an edit is
  portable, offer a draft PR — get feedback there, decide there.

## Process

1. Read `.claude/rasa.lock.json`. Bail clearly if absent.
2. Ensure `kit/<element>/` exists (clone if missing) and `git fetch origin`.
3. For each `element.files[]` file, diff local vs pinned. Skip files in
   `overrides[]`. Collect the drifted set.
4. Classify each drifted file **with the user** (portable / override / mistake
   / both-diverged). Don't bulk-default. Route "both-diverged" to `/sync`.
5. Group the portable edits into coherent PR(s); confirm the grouping.
6. For each PR: in `kit/<element>/`, cut a branch off `origin/<branch>`, apply
   the local edit(s) to the corresponding `from` paths, commit with a clear
   message, and draft the PR title + body (summary, files changed, "how this
   came up in <project>").
7. **On explicit go:** push the branch + open the PR via `gh` (or print the
   manual steps). Record nothing in the project except staged `overrides[]`
   additions for anything classified override.
8. Summarize: promoted (with PR links), marked-override, reverted, deferred.

## When NOT to use this skill

- **You want upstream's changes, not to push yours** → `/sync`.
- **The file is project-specific** → keep it local; add it to `overrides[]`
  (this skill will offer that) — don't force it upstream.
- **Upstream also moved on this file** → `/sync` first to reconcile, then
  `/promote` the result.

## What NOT to do

- Don't push a branch or open a PR without explicit confirmation.
- Don't promote a `seed.files[]` / project-owned file (`CLAUDE.md`, ledgers) —
  those are project-owned by design and never flow upstream.
- Don't auto-commit in the consumer project.
- Don't promote an override the user marked project-specific.

## Done when

Every drifted file is adjudicated (promoted / override-recorded / reverted /
deferred), each portable change is a pushed branch + open PR on the Element's
repo (or exact manual steps printed), `overrides[]` records anything kept
local, and the user has a summary with PR links. The project working tree
carries only the staged `rasa.lock.json` override edits, uncommitted.
