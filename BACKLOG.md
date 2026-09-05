# Backlog — open design questions

Non-urgent design/architecture questions raised (often in code review) that
didn't block a merge, but are worth someone deciding on deliberately rather
than resolving silently in a later PR. Distinct from CLAUDE.md's "Backlog
(explicitly not v1)" section, which is unbuilt *features*; this one is
existing code whose shape is debatable.

CLAUDE.md points here and asks Claude to check this file periodically —
see its own note on that.

## NotifyOptions: generic options bag vs. a dedicated finish-only callback

Raised in review of PR #17 (`autoOpenOutputNote`).

`NotifyOptions` is a single generic bag of optional fields (`outputFile`,
`durationMs`, `openInReadingView`, `autoOpen`, ...) passed to the one
`Notifier` callback used by every notice `SessionManager` fires — roughly
nine call sites (session-already-timed, blocked-session, the per-item "⏱"
notice, two write-failure notices, "not tracked", stop, and the finish
notice).

Only the finish-notice call site is *supposed* to ever set `autoOpen: true`
(and `openInReadingView`, added in #16 the same way). Nothing besides a doc
comment enforces that — a future edit to the shared `resultFileOptions()`
helper, or a new call site that copies the finish notice's options literal,
could silently make the output note auto-open on every checked item, or on
a blocked-session notice — exactly the "disruptive" behavior the code
explicitly says to avoid.

**Suggested fix (not applied):** a dedicated finish-only callback (e.g.
`onSessionFinished(file, opts)`) fired only from `finishSession`, separate
from the generic `Notifier`, making the misuse structurally impossible
instead of convention-dependent.

**Why not done immediately:** `openInReadingView` already follows the same
"flag on the shared bag" pattern (introduced in #16, before `autoOpen`
existed). Splitting only `autoOpen` off onto its own mechanism would leave
the two flags inconsistent with each other; doing both properly is a bigger
redesign of the `Notifier`/`NotifyOptions` port (timer-port.ts) than a
single PR's review pass should decide unilaterally. Needs a deliberate call
on whether to redesign both together, and if so how.

## Check-off detection: positional diff vs. identity-based matching

Raised alongside the mid-run-edit safety net (PR for
`guard-mid-run-checklist-edits`).

`processBlock` (session-manager.ts) detects a check-off purely positionally:
it re-parses the whole note on every event and compares each slot's
checked-boolean to the previous parse, cached in `blockStateCache` keyed by
`path#firstItemLine`. Item N is "newly checked" iff slot N went
`false → true`. Nothing is matched by item identity.

The safety net that shipped only *contains* the failure mode: when item text
at a shared slot changes (an insert/delete/rename that shifted the list), it
skips detection for that event and notifies the user, rather than recording a
phantom timing. It does **not** make mid-run edits work — the edit is simply
not timed, and these cases are still unhandled:

- **Edits above the block / block splits.** Inserting or deleting lines above
  the `#timed` tag moves `block.startLine`, so `blockKey` and `isSameBlock`
  stop matching and the session detaches. A blank/paragraph/indented line
  mid-list splits the block; only the tagged top half stays timed.
- **Deleting or moving the start item itself mid-run.** The safety net updates
  `session.items` and recomputes `session.startIndex` on a shift, but if the
  in-progress item slides up to become the new index-0 start item, checking it
  off next hits the `index === startIndex` branch in `handleItemChecked` and is
  read as a restart ("already being timed"), losing that item's elapsed time.
  Proper handling needs identity-based start-item tracking (point 2 below).
- **A genuine check-off in the same editor event as a structural edit** is
  swallowed by the safety net (the user has to re-tick).
- **A block whose items all share identical text.** An insertion preserves the
  common prefix, so the text comparison sees no shift. Degenerate; noted only
  for completeness (identical text is already indistinguishable downstream).

**Fuller fix (not applied):**

1. Match previous → current items by **text identity** (index as tiebreaker
   for duplicate text), so "newly checked" is an item whose state went
   `false → true` *by identity*, not by slot. Insert-above / delete-above /
   reorder then just work — the plugin follows the actual items.
2. Anchor the session to something **stable** — the start item's text, or the
   `#timed` tag line tracked as its own entity — instead of the first item's
   line number, so edits above the list don't detach the run.
3. "Last item" / completion detection (`index === items.length - 1`) becomes
   last-by-identity rather than last-by-position.

**Why not done now:** it's a real redesign of the detection core and its
cache shape, touches completion/reset logic, and needs duplicate-text
disambiguation thought through. The positional approach is also load-bearing
for the "no session resume" baseline-scan behavior (`!previousState` early
return). Wanted a deliberate decision, not a rushed rewrite inside the
safety-net PR. A hard "freeze the list at session start, reject all edits"
model was considered and rejected as too rigid for real weekly-review runs,
where discovering a missing step mid-run is normal.
