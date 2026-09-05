# Checklist Timer — Philosophy & Design

## Origin

Personal pain point: weekly planning and weekly review (especially planning) take
too long, and it's not clear which steps are the bottleneck. This plugin times
each checklist item so that recurring processes (like a week plan) can be
measured step by step instead of just as one lump duration.

Primary user is the author, but the plugin is built to be generic enough for
others to use, and is meant to be published as a normal community plugin on
GitHub — open source, no monetization. Development happens locally first; the
dev vault at `~/ObsidianDev` (symlinked to this repo) is for that.

## What this is (and isn't)

This is a **process-insight tool**, not a general time tracker:

- It's for repeatable checklists/processes (e.g. a weekly review template) where
  you want to see which steps eat the most time.
- It is **not** a Pomodoro timer.
- It is **not** an invoicing/billable-hours tool. (It *could* be abused for that,
  but there are better tools for that job — not a design goal here.)
- It does not try to replace or wrap the Checklist / Checklist Reset plugins.
  It runs in parallel with the same tag-based convention they use to identify
  checklists, but is otherwise independent.

## Core concept

Not every checklist is timed — only ones the user opts into, via a tag (default
suggestion: `#timed`, but should be configurable in settings). This mirrors how
the Checklist/Checklist Reset plugins identify their checklists, so the
mechanism should feel familiar rather than inventing something new.

## Interaction model (v1)

- A checklist is marked as timed by a tag on its own line **immediately above
  the list** (default tag `#timed`, configurable) — this is the same
  convention the Checklist plugin uses. Example:

  ```
  #timed
  - [ ] Start week plan
  - [ ] Review calendar
  - [ ] Draft priorities
  - [ ] Send updates
  ```

- The start item is whichever item's text contains the start tag (default
  `#start`, configurable). If no item in the block has that tag, the block's
  **first item** is the start item by default — tagging it is optional, not
  required.
- Items before the start item (if the start item isn't the first one) are
  simply not part of the timed sequence — checking them off is a no-op.
- After the start item, checking off each subsequent item stops the clock for
  the interval that just elapsed and attributes that duration to the item just
  checked, then immediately starts timing the next one. So each item's
  recorded time = time between the previous check-off and this one.
- Only **one timer active at a time**, vault-wide — no parallel/concurrent
  checklists or items in v1.
- If you start a second timed checklist while one is already running,
  behavior is configurable (default: **auto-switch**): the first is stopped
  automatically (saving whatever it had timed, marked `(stopped early)`) and
  the second starts. Turning auto-switch off blocks the second checklist
  instead — its check-offs are silently-in-effect but explicitly *not*
  tracked, and the plugin says so via a notice on every check-off attempt
  while blocked, not just the first, so this can't fail silently.
- A session ends either when the last item in the checklist is checked, or via
  a manual stop action in the UI.
- When a session ends by reaching the **last item** (not a manual stop), every
  item in the block is automatically unchecked again — a `resetOnCompletion`
  setting, **default on** — so a recurring checklist (e.g. a weekly review
  template) is immediately ready to run again next time without manual
  cleanup. This includes any pre-start items, so the checklist reads as fully
  blank. A manual stop deliberately does *not* trigger this, since stopping
  early means the run was left incomplete on purpose — blanking it out would
  destroy real progress rather than reset a finished cycle.
- Because the start item is unambiguous (tagged, or first-by-default), there's
  no "checked an item without starting" edge case to handle in v1.
- Nested/indented checklist items (parent items that would need their own
  rolled-up time from children) are **out of scope for v1** — the author
  doesn't use indentation in their checklists currently. Parked as a future
  feature, not a bug to fix now.
- No *session-state* persistence/resume: if Obsidian closes or crashes
  mid-session, the in-memory session (start time, which block it belongs to)
  is simply lost — reopening Obsidian will not pick the timer back up. This is
  intentional simplicity, not an oversight — resuming interrupted sessions is
  backlogged, not v1.
- The output note itself, however, is written incrementally (see below), so
  whichever items were already checked off before a crash/abandonment keep
  their recorded time even though the session can't be resumed.

## Output / data storage

The plugin writes to a note in the vault incrementally, one item at a time,
rather than batching everything until the end:

- The note is created (lazily, on the first item checked after the start
  item) and each subsequent check-off appends a line to it immediately —
  so an abandoned/never-finished checklist still keeps whatever was timed.
- When the session ends — either because the last item was checked, or via
  manual stop (marked `(stopped early)`) — a "Total" line is appended,
  followed by a second list of the same items **sorted slowest-first**, so
  the bottleneck is immediately visible without doing the comparison by eye.
- Output location: configurable folder path, defaulting to vault root.
- Filename: configurable via a template (further templating, e.g. reusing the
  user's existing Templater templates, is a future idea — not v1).
- Content format (v1): a simple bulleted list of `duration - item name`,
  duration formatted as `HH:MM:SS`.
- The note also carries normal Obsidian properties (YAML frontmatter):
  `start`, `end`, `total`, `longest` — a first, small step toward the
  Dataview-friendly direction described below, without waiting for the full
  table/CSV rework. `start` is written the moment the note is created (on
  the first timed item), since the session's actual start time is already
  known by then. `end`/`total`/`longest` are declared at that same moment
  too, but with **empty values** — they're not known until the session
  finishes, but pre-declaring the keys (rather than adding them only at the
  end) means the Properties panel shows a consistent shape from the note's
  first line onward, and a note left behind by a crash or an abandoned run
  (see "No session-state persistence" above) reads correctly as
  *incomplete* rather than missing the fields outright. `finishSession`
  (session-manager.ts) fills them in via simple line-anchored string
  replacement in the same write that appends the footer — no YAML parser
  involved, consistent with how the rest of this file is built. The
  replacement matches `^end:.*$` (any content on the line), not an exact
  `^end: \n` placeholder — the output note being open in a pane (a real,
  common case here; see `autoOpenOutputNote`/`EditorAccess`) means Obsidian's
  own Properties panel can rewrite the raw frontmatter first (e.g. an empty
  `end: ` loses its trailing space down to `end:`), and an exact-match regex
  would silently no-op there, leaving a *completed* run's note looking
  exactly like an abandoned one. `end` is set from `session.lastEventTime`
  (the last check-off), not the instant `finishSession` itself runs — for a
  natural completion the two are the same instant, but a manual stop can
  have an arbitrary idle gap between the last check-off and pressing stop;
  using `lastEventTime` keeps `end - start` always equal to `total`, which a
  Dataview query computing session length from these properties would
  otherwise get wrong by that idle amount. Timestamps use UTC
  (`formatTimestamp`, utils/format.ts) rather than local time, matching
  `renderFilename`'s existing `{{date}}` and keeping output (and tests)
  independent of the machine's timezone — note that new properties default
  to Obsidian's plain Text type, so `start`/`end` don't automatically render
  with its date picker; a user wanting that switches the property's type
  themselves. `total`/`longest` reuse `formatDuration`'s `HH:MM:SS`, matching
  the body list — unlike the body's "Total" line, the frontmatter `total`
  never gets the `(stopped early)` suffix, since that's a display-only
  annotation and the property should hold a plain, parseable duration.
- Duration granularity (minutes-only, or including milliseconds) should be
  configurable eventually, but `HH:MM:SS` is the v1 default.
- `autoOpenOutputNote` (default **on**) opens the output note automatically
  the moment a session finishes (completed or stopped early), instead of only
  linking to it from the clickable finish notice. It rides the same
  `NotifyOptions.filePath` the finish notice already carries — a new
  `autoOpen` flag on that notify call (session-manager.ts) marks *only* the
  finish notice as eligible, since per-item notices also carry `filePath`
  (for their own click-to-open) but auto-opening on every single check-off
  would be disruptive rather than helpful. main.ts's notify implementation is
  what actually calls `workspace.getLeaf(false).openFile()` when both the
  flag and the setting are true — SessionManager stays Obsidian-UI-agnostic
  and never opens anything itself.

Future direction for output format (not v1, but worth designing toward): a
structure that's easy to consume from Dataview queries and/or export to
CSV — keep the core data model simple (name + duration per item) so richer
output formats (table, CSV, Dataview-friendly frontmatter) can be layered on
without a rewrite.

### Bar chart display (opt-in)

`showReadingViewBarChart` lets the output note show at a glance which item
was the bottleneck, without the user comparing raw `HH:MM:SS` numbers by
eye: it renders a small bar next to each timed item (`main.ts`'s
`renderDurationBars()`, driven by the pure duration-matching/sizing logic in
`utils/duration-bars.ts`) via `registerMarkdownPostProcessor()` — Reading
view only, on purpose. Live Preview/Source mode is a separate rendering path
(CodeMirror), and an earlier attempt at injecting a bar there repeatedly
crashed the plugin with internal CodeMirror errors — see "Fixed"/history
below before attempting that path again, and build it incrementally rather
than assuming it'll just work.

The bar renders on its own line below the item's text (a block-level
`<div>` child of the `<li>`), not inline next to it — an inline bar's
starting position would vary with each item's text length, since it'd sit
right after wherever that text happens to end, making the bars hard to
visually compare against each other. On its own line, every bar starts at
the same left edge (the item's own text indentation) regardless of how long
the item's text is.

Since this is Reading-view-only, two more pieces close the loop so a user
actually lands on a rendered chart instead of quietly missing it:

- Clicking the finish notice (main.ts) opens the output note with
  `{ state: { mode: 'preview' } }` — straight into Reading view — but only
  when `showReadingViewBarChart` is on; otherwise the click respects
  whatever mode the leaf would normally default to, since there's nothing
  Reading-view-only to show. `autoOpenOutputNote`'s auto-open (see above)
  goes through the same `openOutputFile()` helper and honors this too, so
  an auto-opened note also lands in Reading view when the bar chart is on.
- The output note itself gets a one-time static hint (a `> [!tip]` callout,
  written into the header alongside the other setting-gated content in
  `appendItem()`) pointing at Reading view — written once, into the note,
  rather than only in a transient notice, so it's still there for anyone
  who opens the note later rather than right after the session ends.

A plain-text character bar (`#`/`-`) in the written note content itself was
also tried, but dropped in favor of the rendered bar alone — see the
"Fixed"/history entries above for why an earlier, uncommitted attempt at a
plain-text bar using Unicode block characters was treated with caution
(a suspected, never-conclusively-root-caused Obsidian crash).

## Platform scope

Desktop-only for now (`isDesktopOnly` can stay conservative) — weekly
review/planning is assumed to happen at a desk, not on mobile.

## Design philosophy

"Obsidian-first": plain-text, tag-driven, and additive to existing workflows
and plugins rather than a walled-off silo. When in doubt, prefer the
convention an existing well-known Obsidian plugin already uses (e.g. tags for
identifying checklists) over inventing a new mechanism.

## Release process (learnings from getting v1.0.0 published)

- **Version bump order matters.** `version-bump.mjs` (run via `npm run
  version`) reads the *target* version from `process.env.npm_package_version`,
  i.e. from `package.json`'s already-updated `version` field — it does not
  take a version as an argument. So the sequence is: `npm version patch
  --no-git-tag-version` (bumps `package.json`/`package-lock.json` without
  creating a git tag) → `npm run version` (propagates that into
  `manifest.json` and adds a `versions.json` entry) → commit.
- **`versions.json` maps plugin version → `minAppVersion`, not version →
  itself.** The template ships a placeholder (`"1.0.0": "1.0.0"`) that's easy
  to leave un-audited. `version-bump.mjs` only *adds* a new entry for a new
  version — it never corrects an existing one, so if `minAppVersion` changes
  (e.g. a new Vault API bumps the floor), double check old entries by hand.
- **The release tag must exactly match `manifest.json`'s `version` — no
  leading `v`.** `.github/workflows/release.yml` triggers on any pushed tag
  (`tags: '*'`), so the tag string itself is what becomes the release; it
  doesn't cross-check against the manifest.
- **The release workflow builds fresh in CI** (`npm ci && npm run build`), so
  local build state never matters — but it also means CI needs the repo in a
  state that actually builds cleanly.
- **The workflow creates the release as a draft, on purpose.** Nothing is
  public until someone manually clicks "Publish release" on GitHub. Easy
  step to forget — a pushed tag alone does not make a version installable.
- **`manifest.json`'s `author` field is required**, not optional, per the
  manifest schema — the sample template ships it blank. `authorUrl` and
  `fundingUrl` are optional; omit them entirely rather than leaving an empty
  string (we have no funding link, per "no monetization" above).
- **The community-directory automated review returns warnings/recommendations
  even on an accepted submission**, not just hard blockers. First round for
  v1.0.0: a warning to adopt `getSettingDefinitions()` (implemented since —
  see release history) and a recommendation to add a release description (we
  did, manually, since there's no way to script that without a GitHub token
  in this dev setup).
- **Every new release needs its own version bump**, even a docs-only change —
  GitHub tags and Obsidian plugin versions must be unique per release.
- **`getSettingDefinitions()` was implemented on `ChecklistTimerSettingTab`**
  (src/settings.ts) alongside the existing imperative `display()`, not
  instead of it — `manifest.json`'s `minAppVersion` (1.4.0) is below 1.13.0,
  so `display()` stays as the fallback for older Obsidian while
  `getSettingDefinitions()` takes over on 1.13.0+ ("dual support", per
  `eslint-plugin-obsidianmd`'s own `no-deprecated-display` rule). Any new
  setting added going forward needs entries in **both** `display()` and
  `getSettingDefinitions()`, and — since the declarative control types have
  no `onChange` hook — any trim/default-fallback logic goes in the
  `setControlValue()` override instead of inline.

## Known issues / possible bugs (unconfirmed)

*(none currently — see "Fixed" below for the entry this section used to hold)*

## Fixed

- **A note the plugin writes to could lose data if it's also open in an
  editor.** Originally flagged for the output note: `appendItem`/
  `finishSession` wrote via `vault.append()`/`vault.modify()` (a direct disk
  write) on every check-off, and if that note was *also* open in a pane,
  Obsidian's editor held its own in-memory copy that could later save back to
  disk and silently clobber the plugin's direct writes (editor buffer stale
  relative to the out-of-band write). The `resetOnCompletion` feature (see
  Interaction model above) added a second, higher-probability instance of the
  same bug class on the *source* checklist note, which is essentially
  guaranteed to be open in an editor at reset time. Mirrors a related bug
  that *was* confirmed and fixed earlier (see git log around 2026-08-22):
  checking off items via the Checklist plugin's sidebar/Reading View writes
  to the checklist note directly too, bypassing any open editor — fixed then
  by also listening to `vault.on('modify')` instead of relying solely on
  `editor-change`.
  - **Fix**: both write paths now go through a single `SessionManager
    .writeNoteContent()` helper (session-manager.ts) that checks — via a new
    `EditorAccess` port (timer-port.ts) implemented in main.ts with
    `workspace.iterateAllLeaves()` — whether the target note is open in any
    pane. If so, it mutates that live `Editor`'s buffer directly
    (`getValue()`/`setValue()`) instead of touching disk; only when no editor
    is open does it fall back to `vault.read()` + `vault.modify()`. Unlike
    the earlier assumption, this *is* coverable by the `node:test` suite —
    `EditorAccess`/`OpenEditor` are narrow enough to fake (see
    `FakeEditorAccess`/`FakeEditor` in session-manager.test.ts) without a
    real Obsidian `Editor`/`MarkdownView`. Still worth a manual pass in the
    dev vault (open the output note and/or a recurring checklist mid-session,
    keep checking off items) since the real `workspace.iterateAllLeaves()`
    wiring in main.ts itself isn't exercised by that test suite.

## Backlog (explicitly not v1)

- Nested/indented checklist time rollup.
- Resuming a session after Obsidian restarts/crashes.
- Table-based output format.
- Dataview-friendly / CSV export output.
- Configurable duration granularity (minutes-only, milliseconds).
- Filename templates that integrate with existing note templates (e.g.
  Templater).

## Open design questions

See `BACKLOG.md` for open design/architecture questions on *existing* code
(as opposed to the unbuilt-feature backlog above) — mostly review feedback
that didn't block a merge but deserves a deliberate decision rather than a
silent resolve later. Claude: check it every so often — e.g. when starting
new work in an area it touches, or every few sessions — since nothing else
will surface it again once its originating PR is merged and out of view.
