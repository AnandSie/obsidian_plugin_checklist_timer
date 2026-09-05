import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatElapsed, formatTimestamp, renderFilename, truncateTaskName } from './format';

describe('formatDuration', () => {
	it('formats zero as 00:00:00', () => {
		assert.equal(formatDuration(0), '00:00:00');
	});

	it('formats seconds and minutes with zero-padding', () => {
		assert.equal(formatDuration(5_000), '00:00:05');
		assert.equal(formatDuration(65_000), '00:01:05');
	});

	it('formats hours correctly', () => {
		assert.equal(formatDuration(3_661_000), '01:01:01');
	});

	it('rounds to the nearest second', () => {
		assert.equal(formatDuration(1_499), '00:00:01');
		assert.equal(formatDuration(1_501), '00:00:02');
	});

	it('clamps negative durations to zero instead of going negative', () => {
		assert.equal(formatDuration(-5_000), '00:00:00');
	});
});

describe('formatElapsed', () => {
	it('defaults to mm:ss with zero-padding', () => {
		assert.equal(formatElapsed(0, 'mm:ss'), '00:00');
		assert.equal(formatElapsed(5_000, 'mm:ss'), '00:05');
		assert.equal(formatElapsed(65_000, 'mm:ss'), '01:05');
	});

	it('floors instead of rounding, so it never jumps ahead of the real clock', () => {
		assert.equal(formatElapsed(1_999, 'mm:ss'), '00:01');
	});

	it('extends the leading unit past 2 digits on overflow instead of rolling over', () => {
		assert.equal(formatElapsed(75 * 60_000 + 32_000, 'mm:ss'), '75:32');
	});

	it('formats hh:mm and drops seconds', () => {
		assert.equal(formatElapsed(0, 'hh:mm'), '00:00');
		assert.equal(formatElapsed(90 * 60_000, 'hh:mm'), '01:30');
	});

	it('overflows hh:mm past 99 hours without rolling over', () => {
		assert.equal(formatElapsed(100 * 3_600_000, 'hh:mm'), '100:00');
	});

	it('formats hh:mm:ss', () => {
		assert.equal(formatElapsed(3_661_000, 'hh:mm:ss'), '01:01:01');
	});

	it('clamps negative elapsed time to zero', () => {
		assert.equal(formatElapsed(-5_000, 'mm:ss'), '00:00');
	});
});

describe('truncateTaskName', () => {
	it('leaves short names untouched', () => {
		assert.equal(truncateTaskName('Review calendar'), 'Review calendar');
	});

	it('truncates long names with an ellipsis at the configured max length', () => {
		const name = 'This is a very long checklist item name';
		const result = truncateTaskName(name, 20);
		assert.equal(result.length, 20);
		assert.ok(result.endsWith('…'));
		assert.equal(result, `${name.slice(0, 19)}…`);
	});

	it('treats a name exactly at the max length as untouched', () => {
		const name = 'x'.repeat(20);
		assert.equal(truncateTaskName(name, 20), name);
	});

	it('does not split a surrogate pair (e.g. an emoji) at the truncation boundary', () => {
		// 18 ASCII chars then a non-BMP emoji (a UTF-16 surrogate pair) landing
		// right at the cut point — a UTF-16-code-unit slice would chop the pair
		// in half and leave a lone, unpaired surrogate in the result.
		const name = `${'x'.repeat(18)}📅 rest of a very long checklist item name`;
		const result = truncateTaskName(name, 20);
		assert.ok(result.includes('📅'), 'the emoji must survive intact, not be split');
		assert.equal(Array.from(result).length, 20, 'length is measured in code points, not UTF-16 units');
	});
});

describe('formatTimestamp', () => {
	it('formats the Unix epoch in UTC', () => {
		assert.equal(formatTimestamp(0), '1970-01-01T00:00:00');
	});

	it('formats a timestamp with seconds, independent of the machine timezone', () => {
		assert.equal(formatTimestamp(1_234_567_890_000), '2009-02-13T23:31:30');
	});
});

describe('renderFilename', () => {
	it('substitutes {{date}} and {{title}}', () => {
		const today = new Date().toISOString().slice(0, 10);
		assert.equal(
			renderFilename('{{date}} {{title}} timing', 'Week Plan'),
			`${today} Week Plan timing`,
		);
	});

	it('substitutes repeated placeholders', () => {
		assert.equal(renderFilename('{{title}}/{{title}}', 'X'), 'X/X');
	});

	it('leaves a template with no placeholders untouched', () => {
		assert.equal(renderFilename('fixed-name', 'X'), 'fixed-name');
	});
});
