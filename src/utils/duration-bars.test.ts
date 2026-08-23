import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeBarFractions, DURATION_LINE, OUTPUT_NOTE_MARKER, parseDurationMs } from './duration-bars';

describe('parseDurationMs', () => {
	it('parses an "In order" style line', () => {
		assert.equal(parseDurationMs('00:04:12 - Draft priorities'), (4 * 60 + 12) * 1000);
	});

	it('parses a line whose item text contains extra " - " separators', () => {
		assert.equal(parseDurationMs('00:00:05 - Two - with a dash in the name'), 5_000);
	});

	it('parses hours past 99 — formatDuration zero-pads to a minimum of 2 digits, not a cap', () => {
		assert.equal(parseDurationMs('100:00:00 - Very long item'), 100 * 3_600_000);
	});

	it('returns null for text that is not a duration line', () => {
		assert.equal(parseDurationMs('Draft priorities'), null);
		assert.equal(parseDurationMs('**Total:** 00:00:08'), null);
	});
});

describe('DURATION_LINE / OUTPUT_NOTE_MARKER', () => {
	it('OUTPUT_NOTE_MARKER matches the exact heading session-manager.ts writes', () => {
		// Regression guard for the two staying in sync — see the scoping check
		// in main.ts's registerMarkdownPostProcessor callback.
		assert.equal(OUTPUT_NOTE_MARKER, '## In order');
	});

	it('DURATION_LINE requires the leading dash-space list marker to be absent (matched against rendered <li> text, not raw markdown)', () => {
		assert.equal(DURATION_LINE.test('- 00:00:05 - Two'), false);
		assert.equal(DURATION_LINE.test('00:00:05 - Two'), true);
	});
});

describe('computeBarFractions', () => {
	it('sizes each duration relative to the slowest one', () => {
		assert.deepEqual(computeBarFractions([5_000, 3_000, 10_000]), [0.5, 0.3, 1]);
	});

	it('returns all-empty bars when every duration is zero, instead of dividing by zero', () => {
		assert.deepEqual(computeBarFractions([0, 0]), [0, 0]);
	});

	it('handles a single item as a full bar', () => {
		assert.deepEqual(computeBarFractions([1_000]), [1]);
	});
});
