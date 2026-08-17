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
- Content format (v1): a simple bulleted list of `item name — duration`,
  duration formatted as `HH:MM:SS`.
- Duration granularity (minutes-only, or including milliseconds) should be
  configurable eventually, but `HH:MM:SS` is the v1 default.

Future direction for output format (not v1, but worth designing toward): a
structure that's easy to consume from Dataview queries and/or export to
CSV — keep the core data model simple (name + duration per item) so richer
output formats (table, CSV, Dataview-friendly frontmatter) can be layered on
without a rewrite.

## Platform scope

Desktop-only for now (`isDesktopOnly` can stay conservative) — weekly
review/planning is assumed to happen at a desk, not on mobile.

## Design philosophy

"Obsidian-first": plain-text, tag-driven, and additive to existing workflows
and plugins rather than a walled-off silo. When in doubt, prefer the
convention an existing well-known Obsidian plugin already uses (e.g. tags for
identifying checklists) over inventing a new mechanism.

## Backlog (explicitly not v1)

- Nested/indented checklist time rollup.
- Resuming a session after Obsidian restarts/crashes.
- Table-based output format.
- Dataview-friendly / CSV export output.
- Configurable duration granularity (minutes-only, milliseconds).
- Filename templates that integrate with existing note templates (e.g.
  Templater).
