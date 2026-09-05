const pad = (n: number) => n.toString().padStart(2, '0');

// Shared by formatDuration and formatElapsed's 'hh:mm:ss' case so the
// hour/minute/second breakdown lives in exactly one place.
function decomposeSeconds(totalSeconds: number): {
	hours: number;
	minutes: number;
	seconds: number;
} {
	return {
		hours: Math.floor(totalSeconds / 3600),
		minutes: Math.floor((totalSeconds % 3600) / 60),
		seconds: totalSeconds % 60,
	};
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const { hours, minutes, seconds } = decomposeSeconds(totalSeconds);
	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

// Status bar time format the user can choose (see ChecklistTimerSettings.activeTaskTimerFormat).
export type TimeFormat = 'mm:ss' | 'hh:mm' | 'hh:mm:ss';

// Formats a live, still-running elapsed time for the status bar. Unlike
// formatDuration (used for finished, recorded durations), this floors rather
// than rounds so the displayed count doesn't jump ahead of the actual clock.
// The leading unit is never capped or rolled over — e.g. 75m32s in 'mm:ss'
// reads "75:32", not "01:15:32" and not a reset to "00:00" — so elapsed time
// past the format's usual range stays readable instead of misleading.
export function formatElapsed(ms: number, format: TimeFormat): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));

	switch (format) {
		case 'hh:mm': {
			const totalMinutes = Math.floor(totalSeconds / 60);
			const hours = Math.floor(totalMinutes / 60);
			const minutes = totalMinutes % 60;
			return `${pad(hours)}:${pad(minutes)}`;
		}
		case 'hh:mm:ss': {
			const { hours, minutes, seconds } = decomposeSeconds(totalSeconds);
			return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
		}
		case 'mm:ss':
		default: {
			const minutes = Math.floor(totalSeconds / 60);
			const seconds = totalSeconds % 60;
			return `${pad(minutes)}:${pad(seconds)}`;
		}
	}
}

const TASK_NAME_MAX_LENGTH = 20;

// Keeps the status bar item compact — a long checklist item shouldn't crowd
// out the rest of Obsidian's status bar. Splits on Unicode code points (not
// UTF-16 code units) via Array.from, so a surrogate pair (e.g. an emoji
// outside the BMP) straddling the cut point is never torn in half.
export function truncateTaskName(
	name: string,
	maxLength: number = TASK_NAME_MAX_LENGTH,
): string {
	const codePoints = Array.from(name);
	if (codePoints.length <= maxLength) return name;
	return `${codePoints.slice(0, maxLength - 1).join('')}…`;
}

// UTC timestamp for the output note's frontmatter, in the layout Obsidian's
// own "Date & time" property type writes/recognizes (so `start`/`end` render
// with its date picker rather than as plain text). UTC rather than local
// time to match renderFilename's existing {{date}} (also toISOString-based)
// and keep results independent of the machine's timezone.
export function formatTimestamp(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19);
}

export function renderFilename(template: string, title: string): string {
	const date = new Date().toISOString().slice(0, 10);
	return template.replace(/\{\{date\}\}/g, date).replace(/\{\{title\}\}/g, title);
}
