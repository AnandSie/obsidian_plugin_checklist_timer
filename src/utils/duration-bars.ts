// Pure logic behind the Reading view bar chart (see
// ChecklistTimerSettings.showReadingViewBarChart) — kept free of any DOM/
// Obsidian API so it's unit-testable without a real Reading view. main.ts
// does the actual DOM work: finding <li> elements, matching their text
// against DURATION_LINE, and using computeBarFractions' output to size a
// rendered bar element per item.

// Matches a rendered list item's text for an output note line, e.g.
// "00:04:12 - Draft priorities" (the "In order" list) or
// "00:04:12 - ####------ - Draft priorities" (the "Slowest first" list with
// showPlainTextBarChart also on — the trailing plain-text bar, if present,
// just becomes part of the captured item text, which is fine since it's
// never read back out).
export const DURATION_LINE = /^(\d{2}):(\d{2}):(\d{2}) - .+$/;

export function parseDurationMs(text: string): number | null {
	const match = DURATION_LINE.exec(text);
	if (!match) return null;
	const [, hh, mm, ss] = match;
	return ((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * 1000;
}

// Fraction (0..1) of the slowest duration in the set, per input entry, in
// the same order — the size to render each item's bar at. A set with a zero
// max (e.g. every item at 0ms) resolves to all-empty bars rather than
// dividing by zero.
export function computeBarFractions(durationsMs: number[]): number[] {
	const max = Math.max(0, ...durationsMs);
	if (max === 0) return durationsMs.map(() => 0);
	return durationsMs.map((duration) => duration / max);
}
