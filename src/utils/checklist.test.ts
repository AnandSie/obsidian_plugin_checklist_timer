import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseChecklistBlocks, findTimedBlocks, resolveStartIndex } from './checklist';

describe('parseChecklistBlocks', () => {
	it('groups contiguous top-level checkbox lines into a block', () => {
		const content = '# Heading\n\n- [ ] One\n- [x] Two\n- [ ] Three\n';
		const blocks = parseChecklistBlocks(content);

		assert.equal(blocks.length, 1);
		assert.equal(blocks[0]?.items.length, 3);
		assert.deepEqual(
			blocks[0]?.items.map((item) => item.checked),
			[false, true, false],
		);
		assert.deepEqual(
			blocks[0]?.items.map((item) => item.text),
			['One', 'Two', 'Three'],
		);
	});

	it('splits separate lists into separate blocks', () => {
		const content = '- [ ] A\n- [ ] B\n\ntext\n\n- [ ] C\n';
		const blocks = parseChecklistBlocks(content);

		assert.equal(blocks.length, 2);
		assert.equal(blocks[0]?.items.length, 2);
		assert.equal(blocks[1]?.items.length, 1);
	});

	it('ignores indented (nested) checkbox lines — out of scope for v1', () => {
		const content = '- [ ] Parent\n  - [ ] Child\n- [ ] Sibling\n';
		const blocks = parseChecklistBlocks(content);

		// The indented line breaks the contiguous top-level run, so "Parent"
		// and "Sibling" end up as two separate one-item blocks.
		assert.equal(blocks.length, 2);
		assert.equal(blocks[0]?.items[0]?.text, 'Parent');
		assert.equal(blocks[1]?.items[0]?.text, 'Sibling');
	});

	it('returns nothing for content with no checklists', () => {
		assert.deepEqual(parseChecklistBlocks('just some text\nno lists here\n'), []);
	});
});

describe('findTimedBlocks', () => {
	it('picks up a block whose preceding line contains the tag', () => {
		const content = '#timed\n- [ ] Start\n- [ ] Next\n';
		const timed = findTimedBlocks(content, '#timed');

		assert.equal(timed.length, 1);
		assert.equal(timed[0]?.items.length, 2);
	});

	it('ignores a block with no tag line above it', () => {
		const content = '- [ ] Start\n- [ ] Next\n';
		assert.deepEqual(findTimedBlocks(content, '#timed'), []);
	});

	it('requires the tag directly above with no blank line gap (v1)', () => {
		const content = '#timed\n\n- [ ] Start\n- [ ] Next\n';
		assert.deepEqual(findTimedBlocks(content, '#timed'), []);
	});

	it('only opts in the block whose tag line matches, leaving others untimed', () => {
		const content = '#timed\n- [ ] A\n- [ ] B\n\n- [ ] C\n- [ ] D\n';
		const timed = findTimedBlocks(content, '#timed');

		assert.equal(timed.length, 1);
		assert.equal(timed[0]?.items[0]?.text, 'A');
	});

	it('respects a custom tag string', () => {
		const content = '#my-process\n- [ ] Start\n- [ ] Next\n';
		assert.equal(findTimedBlocks(content, '#my-process').length, 1);
		assert.equal(findTimedBlocks(content, '#timed').length, 0);
	});

	it('matches the tag case-insensitively, like Obsidian\'s own tag system', () => {
		const content = '#Timed\n- [ ] Start\n- [ ] Next\n';
		assert.equal(findTimedBlocks(content, '#timed').length, 1);
		assert.equal(findTimedBlocks(content, '#TIMED').length, 1);
	});
});

describe('resolveStartIndex', () => {
	it('falls back to the first item when no item has the start tag', () => {
		const content = '#timed\n- [ ] A\n- [ ] B\n- [ ] C\n';
		const block = findTimedBlocks(content, '#timed')[0];
		assert.ok(block);
		assert.equal(resolveStartIndex(block, '#start'), 0);
	});

	it('finds an explicitly tagged start item anywhere in the block', () => {
		const content = '#timed\n- [ ] Prep\n- [ ] #start Kickoff\n- [ ] Middle\n- [ ] End\n';
		const block = findTimedBlocks(content, '#timed')[0];
		assert.ok(block);
		assert.equal(resolveStartIndex(block, '#start'), 1);
	});

	it('uses the first matching item if the start tag appears more than once', () => {
		const content = '#timed\n- [ ] A\n- [ ] #start B\n- [ ] #start C\n';
		const block = findTimedBlocks(content, '#timed')[0];
		assert.ok(block);
		assert.equal(resolveStartIndex(block, '#start'), 1);
	});

	it('matches the start tag case-insensitively', () => {
		const content = '#timed\n- [ ] Prep\n- [ ] #Start Kickoff\n- [ ] Middle\n';
		const block = findTimedBlocks(content, '#timed')[0];
		assert.ok(block);
		assert.equal(resolveStartIndex(block, '#start'), 1);
	});
});
