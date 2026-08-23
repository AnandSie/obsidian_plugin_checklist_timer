import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeBarFractions, parseDurationMs } from './duration-bars';

describe('parseDurationMs', () => {
	it('parses an "In order" style line', () => {
		assert.equal(parseDurationMs('00:04:12 - Draft priorities'), (4 * 60 + 12) * 1000);
	});

	it('parses a "Slowest first" line that already has a plain-text bar', () => {
		assert.equal(
			parseDurationMs('00:00:05 - #####----- - Two'),
			5_000,
		);
	});

	it('returns null for text that is not a duration line', () => {
		assert.equal(parseDurationMs('Draft priorities'), null);
		assert.equal(parseDurationMs('**Total:** 00:00:08'), null);
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
