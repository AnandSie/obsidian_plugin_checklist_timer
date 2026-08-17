export interface ChecklistItem {
	line: number;
	text: string;
	checked: boolean;
}

export interface ChecklistBlock {
	startLine: number;
	endLine: number;
	items: ChecklistItem[];
}

// Only top-level (non-indented) items are recognized in v1 — see CLAUDE.md.
const CHECKLIST_LINE = /^-\s\[([ xX])\]\s*(.*)$/;

export function parseChecklistBlocks(content: string): ChecklistBlock[] {
	const lines = content.split('\n');
	const blocks: ChecklistBlock[] = [];
	let current: ChecklistItem[] = [];
	let startLine = -1;

	const flush = (endLine: number) => {
		if (current.length > 0) {
			blocks.push({ startLine, endLine, items: current });
		}
		current = [];
		startLine = -1;
	};

	lines.forEach((line, index) => {
		const match = CHECKLIST_LINE.exec(line);
		const checkedGroup = match?.[1];
		const textGroup = match?.[2];
		if (match && checkedGroup !== undefined && textGroup !== undefined) {
			if (current.length === 0) startLine = index;
			current.push({
				line: index,
				text: textGroup.trim(),
				checked: checkedGroup.toLowerCase() === 'x',
			});
		} else {
			flush(index - 1);
		}
	});
	flush(lines.length - 1);

	return blocks;
}

// A block is "timed" when the line immediately above it carries the
// configured tag — the same convention the Checklist plugin uses. The
// block's first item (not the tag line) is the start item.
export function findTimedBlocks(
	content: string,
	tag: string,
): ChecklistBlock[] {
	const lines = content.split('\n');
	return parseChecklistBlocks(content).filter((block) => {
		const precedingLine = lines[block.startLine - 1];
		return precedingLine !== undefined && precedingLine.includes(tag);
	});
}
