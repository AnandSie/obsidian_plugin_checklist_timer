// Pure logic behind the Reading view bar chart (see
// ChecklistTimerSettings.showReadingViewBarChart) — kept free of any DOM/
// Obsidian API so it's unit-testable without a real Reading view. main.ts
// does the actual DOM work: finding <li> elements, matching their text
// against DURATION_LINE, and using computeBarFractions' output to size a
// rendered bar element per item.

// Matches a rendered list item's text for an output note line, e.g.
// "00:04:12 - Draft priorities". Hours use \d+ rather than \d{2} — unlike
// minutes/seconds (always exactly 2 digits by construction, see
// decomposeSeconds in utils/format.ts), formatDuration()'s hour component is
// zero-padded to a *minimum* of 2 digits, not capped at 2, so a session past
// 99 hours produces a 3+ digit hour string (e.g. "100:00:00 - Item") that
// \d{2} would fail to match.
export const DURATION_LINE = /^(\d+):(\d{2}):(\d{2}) - .+$/;

export function parseDurationMs(text: string): number | null {
	const match = DURATION_LINE.exec(text);
	if (!match) return null;
	const [, hh, mm, ss] = match;
	return ((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * 1000;
}

// Marks a note as one of this plugin's own timing output notes — the same
// heading appendItem() writes into the header the moment the first item is
// timed (session-manager.ts), so it's present from a session's very first
// write onward, not just once a session finishes. Used to scope the Reading
// view bar chart (main.ts) to notes this plugin actually wrote, instead of
// rendering a bar under *any* rendered list item that happens to look like
// "HH:MM:SS - text" (e.g. a personal log entry) in an unrelated note.
export const OUTPUT_NOTE_MARKER = '## In order';

// Fraction (0..1) of the slowest duration in the set, per input entry, in
// the same order — the size to render each item's bar at. A set with a zero
// max (e.g. every item at 0ms) resolves to all-empty bars rather than
// dividing by zero.
export function computeBarFractions(durationsMs: number[]): number[] {
	const max = Math.max(0, ...durationsMs);
	if (max === 0) return durationsMs.map(() => 0);
	return durationsMs.map((duration) => duration / max);
}
