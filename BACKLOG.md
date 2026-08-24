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
