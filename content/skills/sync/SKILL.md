---
name: sync
description: Smart-sync installed Element content against its upstream source, using the project's local `/kit/<element>/` clone as the reference. Reads .claude/rasa.lock.json for the pinned SHA + overrides, fetches the /kit clone, three-way diffs every Element-managed file (pinned vs upstream HEAD vs local), classifies drift (upstream-only change / local override / both changed / new file / removed file), and proposes per-file pulls. Never auto-commits, never overwrites a recorded override without approval, never touches project-owned files (CLAUDE.md, seed files). On approval, advances pinned_sha. Triggered when the user wants to pull Element updates — e.g. "/sync", "pull latest from the domain", "am I up to date with the Element", "sync the kit".
---

# /sync — Smart-pull upstream Element changes (via /kit)

Bring a consumer project's installed Element content up to date with its
source. One direction only: **upstream → here**. Pushing a change back is
`/promote` — reviewed before it propagates.

The reference copy is the project's **`/kit/<element>/`** clone — a fresh git
clone of the Element's source repo, dropped in at install by `bin/init` and
pinned to the installed SHA. `/sync` fetches that clone, diffs against your
installed `.claude/` copy, and pulls what you approve. Honest about conflicts:
surface drift, don't silently merge.

## Behavior contract

- **Read `.claude/rasa.lock.json` first.** It names the Element (`name`,
  `repo`, `branch`), the current `pinned_sha`, and the `overrides[]`. If it's
  missing, this project wasn't installed from a rasa Element — stop and
  explain rather than guessing.
- **The `/kit/<element>/` clone is the reference.** Locate it at
  `<project>/kit/<element>/` (the folder `bin/init` cloned). If it's absent,
  clone it fresh from `rasa.lock.json#repo` at `branch`. Then
  `git -C kit/<element> fetch origin` — never trust the clone to be current
  without fetching.
- **Three-way diff every Element-managed file** (those declared in the
  Element's `rasa.json` `element.files[]`, resolved through their policies).
  Compare three versions per file — **pinned** (`git -C kit/<element> show
  <pinned_sha>:<from>`), **upstream HEAD** (`git -C kit/<element> show
  origin/<branch>:<from>`), and **local** (`.claude/<to>`). Classify:
  - **Upstream changed, local unchanged** → safe pull; propose.
  - **Upstream unchanged, local changed** → local edit. In `overrides[]` →
    respect it (surface for awareness). Not recorded → flag loudly as
    unmanaged drift (see `contract-rules.md`); offer to record it or `/promote` it.
  - **Both changed** → conflict; show both diffs (each vs pinned), let the
    user choose.
  - **New upstream file** → propose adding.
  - **File removed upstream** → propose removing; deletes are destructive,
    confirm explicitly (back up to `.claude/_archive/<file>.<date>` first).
- **Project-owned files are off-limits.** `CLAUDE.md`, everything from the
  Element's `seed.files[]`, and the project's own history/docs were seeded
  once and are the project's forever. Sync never touches them, regardless of
  drift. The `/kit/` clone itself is never edited by `/sync` (that's `/promote`).
- **Respect recorded overrides.** A path in `overrides[]` is intentionally
  diverged. Never overwrite it without explicit approval, even on an upstream
  change.
- **Never auto-commit.** Apply approved pulls to the `.claude/` working tree;
  the user reviews with `git diff`.
- **Advance the pin only after applying.** Once the user accepts the pulls,
  update `pinned_sha` (and `installed_at`) to the fetched HEAD, and fast-forward
  the `/kit/<element>/` checkout to it. A pin that moves without the diff being
  applied is a lie.

## Process

1. Read `.claude/rasa.lock.json`. Bail clearly if absent.
2. Ensure `kit/<element>/` exists (clone if missing); `git fetch origin` in it.
3. Build the file list from the Element's `rasa.json#element.files[]`; three-way
   diff + classify each against the local `.claude/` copy.
4. Present a per-file plan grouped by classification. Conflicts and deletes
   require explicit choices. (Optional: render the CHANGELOG delta between
   `pinned_sha` and HEAD so the user sees what releases they're pulling.)
5. Apply approved changes to the `.claude/` working tree (back up before any
   overwrite/delete).
6. Update `pinned_sha` + `installed_at`; fast-forward the `kit/<element>/`
   checkout to HEAD. Leave everything uncommitted.
7. Summarize: pulled, skipped, conflicted, overridden.

## When NOT to use this skill

- **You improved something and want it upstream** → `/promote` (the reverse
  direction). Sync is one-way.
- **You want it applied hands-off** → a `/sync-all` autonomous variant, if the
  Element ships one. Plain `/sync` proposes per file.

## What NOT to do

- Don't merge silently or "resolve" a conflict without the user.
- Don't overwrite a recorded override, `CLAUDE.md`, or any `seed.files[]` path.
- Don't advance the pin without applying the diff. Don't auto-commit.
- Don't edit the `/kit/<element>/` clone here — it's the read reference; writes
  to it belong to `/promote`.

## Done when

The `.claude/` working tree reflects the approved pulls, `pinned_sha` matches
what was actually applied, the `/kit/<element>/` checkout is at that SHA,
overrides are intact, and the user has a clear summary of what changed and
what was deliberately left alone.
