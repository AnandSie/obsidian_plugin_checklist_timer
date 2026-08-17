import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, renderFilename } from './format';

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
