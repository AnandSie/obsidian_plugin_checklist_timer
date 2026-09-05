import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TFile } from 'obsidian';
import { SessionManager } from './session-manager';
import { DEFAULT_SETTINGS, ChecklistTimerSettings } from './settings-schema';
import type { EditorAccess, NotifyOptions, OpenEditor, VaultAccess } from './timer-port';

// In-memory stand-in for Obsidian's Vault — real TFile objects are opaque to
// SessionManager (it never inspects them beyond passing them back into
// read()/modify()), so a plain object with a `path` is a faithful enough
// double.
class FakeVault implements VaultAccess {
	// Output notes created via create() — the only files SessionManager ever
	// creates itself, so this also doubles as "does an output note exist yet".
	files = new Map<string, string>();
	folders = new Set<string>();
	// Any other on-disk content a test seeds — models a source checklist note
	// that was never create()'d by SessionManager but can still be read()/
	// modify()'d (e.g. by the reset-on-completion feature).
	disk = new Map<string, string>();
	// Test hook: makes the next modify() call reject, to exercise write-failure paths.
	failNextModify = false;
	// Test hook: makes the next modify() call for this specific path reject —
	// lets a test target one write (e.g. the reset) when another modify()
	// call (e.g. the finish footer) legitimately happens first in the same tick.
	failModifyForPath: string | null = null;
	// Test hook: when set, create()/modify() await this before proceeding —
	// lets a test pause mid-write to inspect state during the await window
	// (e.g. between the last item's check-off and finishSession completing).
	gate: Promise<void> | null = null;

	getAbstractFileByPath(path: string): unknown {
		if (this.files.has(path) || this.folders.has(path)) return { path };
		return null;
	}

	// Mirrors real Obsidian's TFile/TFolder distinction: only a path tracked
	// in `files` (created via create(), never createFolder()) counts.
	getExistingFile(path: string): TFile | null {
		return this.files.has(path) ? ({ path } as unknown as TFile) : null;
	}

	async createFolder(path: string): Promise<unknown> {
		this.folders.add(path);
		return { path };
	}

	async create(path: string, content: string): Promise<TFile> {
		if (this.gate) await this.gate;
		if (this.files.has(path) || this.folders.has(path)) {
			throw new Error(`already exists: ${path}`);
		}
		this.files.set(path, content);
		return { path } as unknown as TFile;
	}

	async read(file: TFile): Promise<string> {
		const path = (file as unknown as { path: string }).path;
		if (this.files.has(path)) return this.files.get(path) as string;
		if (this.disk.has(path)) return this.disk.get(path) as string;
		throw new Error(`read missing file: ${path}`);
	}

	async modify(file: TFile, content: string): Promise<void> {
		if (this.gate) await this.gate;
		const path = (file as unknown as { path: string }).path;
		if (this.failNextModify || this.failModifyForPath === path) {
			this.failNextModify = false;
			this.failModifyForPath = null;
			throw new Error('simulated disk error');
		}
		if (this.files.has(path)) {
			this.files.set(path, content);
		} else {
			this.disk.set(path, content);
		}
	}

	// Test helper: find the single stored file whose path contains `needle`.
	findContent(needle: string): string | undefined {
		const path = [...this.files.keys()].find((p) => p.includes(needle));
		return path ? this.files.get(path) : undefined;
	}
}

// Stand-in for Obsidian's Editor — just enough surface (getValue/setValue)
// for writeNoteContent to treat it as the source of truth when a note is
// open in a pane, instead of falling back to FakeVault's read/modify.
class FakeEditor implements OpenEditor {
	constructor(private content: string) {}
	getValue(): string {
		return this.content;
	}
	setValue(value: string): void {
		this.content = value;
	}
}

class FakeEditorAccess implements EditorAccess {
	private editors = new Map<string, FakeEditor>();

	// Simulates the note at `path` being open in a pane with `content` as the
	// editor's current (possibly unsaved) buffer.
	open(path: string, content: string): FakeEditor {
		const editor = new FakeEditor(content);
		this.editors.set(path, editor);
		return editor;
	}

	getOpenEditor(path: string): OpenEditor | null {
		return this.editors.get(path) ?? null;
	}
}

function sourceFile(path: string): TFile {
	const basename = path.replace(/\.md$/, '');
	return { path, basename } as unknown as TFile;
}

// Manually advanceable clock so recorded durations are exact and tests don't
// depend on wall-clock timing.
class FakeClock {
	private time = 0;
	now = (): number => this.time;
	advance(ms: number) {
		this.time += ms;
	}
}

function makeManager(
	vault: FakeVault,
	clock: FakeClock,
	overrides: Partial<ChecklistTimerSettings> = {},
	normalizePath: (path: string) => string = (path) => path,
	editorAccess?: EditorAccess,
) {
	const notices: string[] = [];
	const noticeOptions: (NotifyOptions | undefined)[] = [];
	let statusChangeCount = 0;
	const settings: ChecklistTimerSettings = { ...DEFAULT_SETTINGS, ...overrides };
	const manager = new SessionManager(
		vault,
		settings,
		() => {
			statusChangeCount++;
		},
		(message, options) => {
			notices.push(message);
			noticeOptions.push(options);
		},
		clock.now,
		normalizePath,
		editorAccess,
	);
	return { manager, notices, noticeOptions, getStatusChangeCount: () => statusChangeCount };
}

describe('SessionManager — basic sequential timing', () => {
	let vault: FakeVault;
	let clock: FakeClock;

	beforeEach(() => {
		vault = new FakeVault();
		clock = new FakeClock();
	});

	it('times each item as the gap since the previous check-off and appends incrementally', async () => {
		const { manager, notices } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		const baseline = '#timed\n- [ ] Start\n- [ ] Two\n- [ ] Three\n';
		await manager.handleFileContent(file, baseline);
		assert.equal(vault.files.size, 0, 'baseline scan must not fire events');

		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n- [ ] Three\n');
		assert.ok(notices.includes('▶️ "Week Plan" started'));
		assert.equal(vault.files.size, 0, 'starting the clock does not create the note yet');

		clock.advance(5_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n- [ ] Three\n');
		assert.equal(
			vault.findContent('Week Plan timing'),
			'---\nstart: 1970-01-01T00:00:00\nend: \ntotal: \nlongest: \n---\n\n' +
				'# Week Plan timing\n\nSource: [[Week Plan]]\n\n## In order\n\n- 00:00:05 - Two\n',
		);

		clock.advance(3_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n- [x] Three\n');

		assert.equal(
			vault.findContent('Week Plan timing'),
			'---\nstart: 1970-01-01T00:00:00\nend: 1970-01-01T00:00:08\ntotal: 00:00:08\nlongest: 00:00:05\n---\n\n' +
				'# Week Plan timing\n\n' +
				'Source: [[Week Plan]]\n\n' +
				'## Slowest first\n\n' +
				'- 00:00:05 - Two\n' +
				'- 00:00:03 - Three\n' +
				'\n**Total:** 00:00:08\n\n' +
				'## In order\n\n' +
				'- 00:00:05 - Two\n' +
				'- 00:00:03 - Three\n',
		);
		assert.ok(notices.some((n) => n.includes('finished in') && n.includes('click to open')));
	});

	it('does not time items before the start item', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Note.md');
		const content = '#timed\n- [ ] Prep (not timed)\n- [ ] #start Kickoff\n- [ ] Next\n';

		await manager.handleFileContent(file, content);
		await manager.handleFileContent(
			file,
			'#timed\n- [x] Prep (not timed)\n- [ ] #start Kickoff\n- [ ] Next\n',
		);
		assert.equal(vault.files.size, 0, 'checking a pre-start item must be a no-op');
	});

	it('silently ignores checking an item when nothing has been started', async () => {
		const { manager, notices } = makeManager(vault, clock);
		const file = sourceFile('Note.md');
		const content = '#timed\n- [ ] Start\n- [ ] Two\n- [ ] Three\n';

		await manager.handleFileContent(file, content);
		// "Two" checked without ever checking "Start" first.
		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [x] Two\n- [ ] Three\n');

		assert.equal(vault.files.size, 0);
		assert.deepEqual(notices, [], 'no active session — no unrelated notice should fire');
	});

	it('manual stop finalizes early with a distinguishing suffix', async () => {
		const { manager, notices } = makeManager(vault, clock);
		const file = sourceFile('Note.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n- [ ] Three\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n- [ ] Three\n');
		clock.advance(10_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n- [ ] Three\n');

		await manager.stopActiveSession();

		const content = vault.findContent('Note timing');
		assert.ok(content?.includes('**Total:** 00:00:10 (stopped early)'));
		assert.ok(!content?.includes('Three'), 'unchecked item must not appear');
		assert.ok(
			notices.some((n) => n.includes('finished in') && n.includes('(stopped early)')),
		);
	});

	it('stopping with nothing timed writes no file', async () => {
		const { manager, notices } = makeManager(vault, clock);
		const file = sourceFile('Note.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');
		await manager.stopActiveSession();

		assert.equal(vault.files.size, 0);
		assert.ok(notices.includes('Checklist timer: stopped (no items timed).'));
	});

	it('finishing fires a single clickable notice with the duration and a longer timeout', async () => {
		const { manager, notices, noticeOptions } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');
		clock.advance(7_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n');

		const finishIndex = notices.findIndex((n) => n.includes('finished in 00:00:07'));
		assert.notEqual(finishIndex, -1, 'a single finish notice with the total duration should fire');
		assert.ok(notices[finishIndex]?.includes('click to open'), 'it should read as a CTA');
		assert.equal(
			notices.filter((n) => n.includes('finished in') || n.includes('saved timing to')).length,
			1,
			'only one notice should fire at session end, not two',
		);

		const outputPath = [...vault.files.keys()][0];
		assert.equal(
			noticeOptions[finishIndex]?.outputFile?.path,
			outputPath,
			'the finish notice should carry the output file so it can be opened on click',
		);
		assert.ok(
			(noticeOptions[finishIndex]?.durationMs ?? 0) > 5000,
			'the finish notice should stay visible longer than Obsidian’s default',
		);
		assert.equal(
			noticeOptions[finishIndex]?.autoOpen,
			true,
			'only the finish notice should be eligible for auto-opening the output note',
		);
		assert.ok(
			noticeOptions.filter((options) => options?.autoOpen).length === 1,
			'per-item notices must not set autoOpen even though they also carry outputFile',
		);
	});

	it('does not fire a misleading per-item notice when the write actually fails', async () => {
		const { manager, notices } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n- [ ] Three\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n- [ ] Three\n');

		// First item creates the file successfully...
		clock.advance(1_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n- [ ] Three\n');
		assert.ok(notices.some((n) => n.includes('⏱ 00:00:01 - Two')));

		// ...but the write for the second item fails.
		vault.failNextModify = true;
		clock.advance(1_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n- [x] Three\n');

		assert.ok(
			notices.some((n) => n.includes('failed to write to')),
			'the failure must be reported',
		);
		assert.ok(
			!notices.some((n) => n.includes('⏱ 00:00:01 - Three')),
			'no success-looking notice should fire for an item that was never actually saved',
		);
	});

	it('stopActiveSession with no session running just notifies', async () => {
		const { manager, notices } = makeManager(vault, clock);
		await manager.stopActiveSession();
		assert.deepEqual(notices, ['Checklist timer: no active timer.']);
	});
});

describe('SessionManager — output note frontmatter', () => {
	let vault: FakeVault;
	let clock: FakeClock;

	beforeEach(() => {
		vault = new FakeVault();
		clock = new FakeClock();
	});

	it('captures the session start time even though the note itself is created later, on the first timed item', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');
		// Time passes between the start item and the first note-creating
		// check-off — the frontmatter's `start` must still reflect the former,
		// not the latter.
		clock.advance(4_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n');

		const content = vault.findContent('Week Plan timing');
		assert.ok(
			content?.startsWith('---\nstart: 1970-01-01T00:00:00\n'),
			`start should be the session's start time, not the note's creation time:\n${content}`,
		);
	});

	it('leaves end/total/longest empty until the session finishes, so an abandoned note reads as incomplete', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n- [ ] Three\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n- [ ] Three\n');
		clock.advance(1_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n- [ ] Three\n');

		const content = vault.findContent('Week Plan timing');
		assert.ok(content?.includes('\nend: \n'));
		assert.ok(content?.includes('\ntotal: \n'));
		assert.ok(content?.includes('\nlongest: \n'));
	});

	it('fills in end/total/longest on finish, with longest matching the slowest item', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n- [ ] Three\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n- [ ] Three\n');
		clock.advance(2_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n- [ ] Three\n');
		clock.advance(5_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n- [x] Three\n');

		const content = vault.findContent('Week Plan timing');
		assert.ok(content?.includes('\nend: 1970-01-01T00:00:07\n'));
		assert.ok(content?.includes('\ntotal: 00:00:07\n'));
		assert.ok(
			content?.includes('\nlongest: 00:00:05\n'),
			'longest must be Three\'s 5s, not the 2s of Two',
		);
	});

	it('fills in end/total/longest on a manual stop too, without the "(stopped early)" suffix that only the body Total line carries', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n- [ ] Three\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n- [ ] Three\n');
		clock.advance(3_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n- [ ] Three\n');

		// An idle gap between the last check-off and the stop command itself —
		// `end` must reflect the former (the last metered instant), not the
		// latter, so `end - start` stays equal to `total` rather than
		// over-counting the idle tail. See finishSession's comment on this.
		clock.advance(10 * 60_000);
		await manager.stopActiveSession();

		const content = vault.findContent('Week Plan timing');
		assert.ok(content?.includes('\nend: 1970-01-01T00:00:03\n'), 'end must be the last check-off, not the later stop time');
		assert.ok(content?.includes('\ntotal: 00:00:03\n'));
		assert.ok(content?.includes('\nlongest: 00:00:03\n'));
		assert.ok(content?.includes('**Total:** 00:00:03 (stopped early)'));
	});

	it('still fills in end/total/longest when the placeholder lines no longer have their exact original spacing', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');
		clock.advance(1_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n');

		// Simulates Obsidian rewriting the note's raw frontmatter out from
		// under us — e.g. its Properties panel (shown while the note is open
		// in a pane, a documented case here via autoOpenOutputNote/
		// EditorAccess) strips the trailing space from an empty `end: ` down
		// to `end:` when it re-serializes the YAML block. The fill-in must
		// still find and replace these lines, not silently no-op.
		const outputPath = [...vault.files.keys()][0] as string;
		const rewritten = (vault.files.get(outputPath) as string)
			.replace('end: \n', 'end:\n')
			.replace('total: \n', 'total:\n')
			.replace('longest: \n', 'longest:\n');
		vault.files.set(outputPath, rewritten);

		await manager.stopActiveSession();

		const content = vault.files.get(outputPath);
		assert.ok(content?.includes('\nend: 1970-01-01T00:00:01\n'));
		assert.ok(content?.includes('\ntotal: 00:00:01\n'));
		assert.ok(content?.includes('\nlongest: 00:00:01\n'));
	});
});

describe('SessionManager — reading view bar chart hint', () => {
	let vault: FakeVault;
	let clock: FakeClock;

	beforeEach(() => {
		vault = new FakeVault();
		clock = new FakeClock();
	});

	it('omits the hint when the setting is off (default)', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');
		clock.advance(5_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n');

		const content = vault.findContent('Week Plan timing');
		assert.ok(!content?.includes('[!tip]'), `hint should not appear:\n${content}`);
	});

	it('writes a static hint pointing at Reading view once, right after the note is created', async () => {
		const { manager } = makeManager(vault, clock, { showReadingViewBarChart: true });
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n- [ ] Three\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n- [ ] Three\n');
		clock.advance(5_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n- [ ] Three\n');
		clock.advance(3_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n- [x] Three\n');

		const content = vault.findContent('Week Plan timing');
		assert.equal(
			content,
			'---\nstart: 1970-01-01T00:00:00\nend: 1970-01-01T00:00:08\ntotal: 00:00:08\nlongest: 00:00:05\n---\n\n' +
				'# Week Plan timing\n\n' +
				'Source: [[Week Plan]]\n\n' +
				'> [!tip] Switch to Reading view (📖 the book icon) to see each item as a bar chart.\n\n' +
				'## Slowest first\n\n' +
				'- 00:00:05 - Two\n' +
				'- 00:00:03 - Three\n' +
				'\n**Total:** 00:00:08\n\n' +
				'## In order\n\n' +
				'- 00:00:05 - Two\n' +
				'- 00:00:03 - Three\n',
		);
		assert.equal(content?.match(/\[!tip\]/g)?.length, 1, 'the hint must appear exactly once, not per item');
	});
});

describe('SessionManager — getActiveTask', () => {
	let vault: FakeVault;
	let clock: FakeClock;

	beforeEach(() => {
		vault = new FakeVault();
		clock = new FakeClock();
	});

	it('is null when nothing is running', async () => {
		const { manager } = makeManager(vault, clock);
		assert.equal(manager.getActiveTask(), null);
	});

	it('reports the item after start as the active task once the clock starts', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n- [ ] Three\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n- [ ] Three\n');

		assert.deepEqual(manager.getActiveTask(), { name: 'Two', startTime: 0 });
	});

	it('advances to the next item, with a fresh start time, on each check-off', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n- [ ] Three\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n- [ ] Three\n');

		clock.advance(5_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n- [ ] Three\n');

		assert.deepEqual(manager.getActiveTask(), { name: 'Three', startTime: 5_000 });
	});

	it('is null again once the session finishes', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');
		clock.advance(1_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n');

		assert.equal(manager.getActiveTask(), null);
	});

	it('is null again after a manual stop', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');
		await manager.stopActiveSession();

		assert.equal(manager.getActiveTask(), null);
	});

	it('reports the first still-unchecked item after start, not the positionally-next one, when items are checked out of order', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(
			file,
			'#timed\n- [ ] Start\n- [ ] Two\n- [ ] Three\n- [ ] Four\n- [ ] Five\n',
		);
		await manager.handleFileContent(
			file,
			'#timed\n- [x] Start\n- [ ] Two\n- [ ] Three\n- [ ] Four\n- [ ] Five\n',
		);

		// "Four" gets checked out of order (e.g. via a bulk edit, or another
		// plugin's sidebar), skipping "Two" and "Three".
		await manager.handleFileContent(
			file,
			'#timed\n- [x] Start\n- [ ] Two\n- [ ] Three\n- [x] Four\n- [ ] Five\n',
		);

		assert.equal(
			manager.getActiveTask()?.name,
			'Two',
			'must report the first still-unchecked item, not "Five" (positionally after "Four")',
		);
	});

	it('returns null as soon as the last item is checked, even before the async finish write completes', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');

		let releaseGate!: () => void;
		vault.gate = new Promise((resolve) => {
			releaseGate = resolve;
		});

		const finishing = manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n');
		// Flush already-queued microtasks without letting the gated vault write
		// (creating the output note) resolve — this is the exact window between
		// the last item's check-off and finishSession nulling the session.
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(
			manager.getActiveTask(),
			null,
			'must not show a stale/misleading task while the finish write is still pending',
		);

		releaseGate();
		await finishing;
	});
});

describe('SessionManager — two checklists started while one is running', () => {
	let vault: FakeVault;
	let clock: FakeClock;

	beforeEach(() => {
		vault = new FakeVault();
		clock = new FakeClock();
	});

	it('auto-switch (default): stops the first checklist and starts the second', async () => {
		const { manager, notices, noticeOptions } = makeManager(vault, clock, {
			autoSwitchSessions: true,
		});
		const fileA = sourceFile('Checklist A.md');
		const fileB = sourceFile('Checklist B.md');

		await manager.handleFileContent(fileA, '#timed\n- [ ] Start\n- [ ] Two\n- [ ] Three\n');
		await manager.handleFileContent(fileA, '#timed\n- [x] Start\n- [ ] Two\n- [ ] Three\n');
		clock.advance(2_000);
		await manager.handleFileContent(fileA, '#timed\n- [x] Start\n- [x] Two\n- [ ] Three\n');

		// B's checklist starts while A is still mid-flight (A never reached "Three").
		await manager.handleFileContent(fileB, '#timed\n- [ ] Kickoff\n- [ ] Wrap up\n');
		await manager.handleFileContent(fileB, '#timed\n- [x] Kickoff\n- [ ] Wrap up\n');

		assert.ok(
			notices.some((n) => n.includes('stopping "Checklist A" first')),
			'should explain why A was stopped',
		);
		const aFinishIndex = notices.findIndex((n) => n.includes('finished in'));
		assert.notEqual(aFinishIndex, -1, 'A must be saved');
		assert.ok(notices.includes('▶️ "Checklist B" started'), 'B must start');
		assert.ok(
			!noticeOptions[aFinishIndex]?.autoOpen,
			"A's incidental auto-switch stop must not auto-open its note — the user is mid-check-off on B, not asking to see A's results",
		);

		const aContent = vault.findContent('Checklist A timing');
		assert.ok(aContent?.includes('**Total:** 00:00:02 (stopped early)'));
		assert.ok(!aContent?.includes('Three'), 'A never reached its last item');

		// B keeps timing normally after the switch.
		clock.advance(1_000);
		await manager.handleFileContent(fileB, '#timed\n- [x] Kickoff\n- [x] Wrap up\n');
		const bContent = vault.findContent('Checklist B timing');
		assert.ok(bContent?.includes('**Total:** 00:00:01\n'));
		assert.ok(!bContent?.includes('stopped early'));
	});

	it('blocking mode: second checklist is not tracked while the first runs', async () => {
		const { manager, notices } = makeManager(vault, clock, { autoSwitchSessions: false });
		const fileA = sourceFile('Checklist A.md');
		const fileB = sourceFile('Checklist B.md');

		await manager.handleFileContent(fileA, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(fileA, '#timed\n- [x] Start\n- [ ] Two\n');

		await manager.handleFileContent(fileB, '#timed\n- [ ] Kickoff\n- [ ] Wrap up\n');
		await manager.handleFileContent(fileB, '#timed\n- [x] Kickoff\n- [ ] Wrap up\n');

		assert.ok(
			notices.some((n) => n.includes("won't be tracked")),
			'must clearly explain B is not being tracked',
		);
		assert.equal(vault.files.size, 0, 'B produced no file, A has no timed items yet either');

		// Checking B's second item should also be clearly flagged as untracked,
		// not silently ignored (this was the original bug being fixed).
		await manager.handleFileContent(fileB, '#timed\n- [x] Kickoff\n- [x] Wrap up\n');
		assert.ok(
			notices.some((n) => n.includes('not tracked') && n.includes('Checklist A')),
			'checking further items in the blocked checklist should keep notifying',
		);
		assert.equal(vault.files.size, 0, 'B must never produce a file in blocking mode');

		// A is unaffected and keeps timing normally.
		clock.advance(6_000);
		await manager.handleFileContent(fileA, '#timed\n- [x] Start\n- [x] Two\n');
		const aContent = vault.findContent('Checklist A timing');
		assert.ok(aContent?.includes('**Total:** 00:00:06\n'));
		assert.ok(!aContent?.includes('stopped early'));
	});

	it('carries the output path on notices once a file exists, but not before', async () => {
		const { manager, notices, noticeOptions } = makeManager(vault, clock, {
			autoSwitchSessions: false,
		});
		const fileA = sourceFile('Checklist A.md');
		const fileB = sourceFile('Checklist B.md');

		await manager.handleFileContent(fileA, '#timed\n- [ ] Start\n- [ ] Two\n- [ ] Three\n');
		await manager.handleFileContent(fileA, '#timed\n- [x] Start\n- [ ] Two\n- [ ] Three\n');
		await manager.handleFileContent(fileB, '#timed\n- [ ] Kickoff\n- [ ] Wrap up\n');
		await manager.handleFileContent(fileB, '#timed\n- [x] Kickoff\n- [ ] Wrap up\n');

		const notTrackedYetIndex = notices.findIndex((n) => n.includes("won't be tracked"));
		assert.notEqual(notTrackedYetIndex, -1);
		assert.equal(
			noticeOptions[notTrackedYetIndex]?.outputFile,
			undefined,
			'A has no timed items yet, so there is nothing to open',
		);

		// "Two" is not A's last item, so A stays active (with an output file now).
		clock.advance(4_000);
		await manager.handleFileContent(fileA, '#timed\n- [x] Start\n- [x] Two\n- [ ] Three\n');
		const outputPath = [...vault.files.keys()][0];

		// B is still blocked; now A has a real output file to point to.
		await manager.handleFileContent(fileB, '#timed\n- [ ] Kickoff\n- [ ] Wrap up\n');
		await manager.handleFileContent(fileB, '#timed\n- [x] Kickoff\n- [ ] Wrap up\n');
		const notTrackedIndex = notices.findIndex(
			(n, i) => n.includes("won't be tracked") && i > notTrackedYetIndex,
		);
		assert.notEqual(notTrackedIndex, -1);
		assert.equal(noticeOptions[notTrackedIndex]?.outputFile?.path, outputPath);
	});

	it('re-checking the start item of the already-active checklist is a no-op, not a restart', async () => {
		const { manager, notices } = makeManager(vault, clock);
		const file = sourceFile('Note.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');

		// Simulate unchecking and rechecking the start item mid-session.
		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');

		assert.ok(notices.some((n) => n.includes('already being timed')));

		clock.advance(1_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n');
		const content = vault.findContent('Note timing');
		assert.ok(content?.includes('00:00:01 - Two'), 'the original session must still be intact');
	});
});

describe('SessionManager — reset checklist on completion', () => {
	let vault: FakeVault;
	let clock: FakeClock;

	beforeEach(() => {
		vault = new FakeVault();
		clock = new FakeClock();
	});

	// Mirrors production: main.ts always hands SessionManager the same content
	// it just read (from the editor or a fresh vault.cachedRead), so keeping
	// FakeVault's "disk" in sync with each call is what makes the no-open-
	// editor fallback path (vault.read then vault.modify) exercisable here.
	async function tick(manager: SessionManager, file: TFile, content: string) {
		vault.disk.set(file.path, content);
		await manager.handleFileContent(file, content);
	}

	it('unchecks every item (including pre-start ones) once the session finishes naturally', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await tick(manager, file, '#timed\n- [x] Prep\n- [ ] #start Kickoff\n- [ ] Two\n');
		await tick(manager, file, '#timed\n- [x] Prep\n- [x] #start Kickoff\n- [ ] Two\n');
		clock.advance(1_000);
		await tick(manager, file, '#timed\n- [x] Prep\n- [x] #start Kickoff\n- [x] Two\n');

		assert.equal(
			vault.disk.get('Week Plan.md'),
			'#timed\n- [ ] Prep\n- [ ] #start Kickoff\n- [ ] Two\n',
			'the source note should have every box in the block unchecked, pre-start items included',
		);
	});

	it('writes through the open editor instead of vault.modify when the source note is open', async () => {
		const editorAccess = new FakeEditorAccess();
		const { manager } = makeManager(vault, clock, {}, undefined, editorAccess);
		const file = sourceFile('Week Plan.md');
		const editor = editorAccess.open(file.path, '#timed\n- [ ] Start\n- [ ] Two\n');

		await manager.handleFileContent(file, editor.getValue());
		editor.setValue('#timed\n- [x] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, editor.getValue());
		clock.advance(1_000);
		editor.setValue('#timed\n- [x] Start\n- [x] Two\n');
		await manager.handleFileContent(file, editor.getValue());

		assert.equal(
			editor.getValue(),
			'#timed\n- [ ] Start\n- [ ] Two\n',
			'the live editor buffer should be reset directly',
		);
		assert.equal(vault.disk.size, 0, 'no raw vault write should happen while an editor is open');
	});

	it('also appends to the output note through its open editor, not vault.modify', async () => {
		const editorAccess = new FakeEditorAccess();
		const { manager } = makeManager(vault, clock, {}, undefined, editorAccess);
		const file = sourceFile('Week Plan.md');

		await tick(manager, file, '#timed\n- [ ] Start\n- [ ] Two\n- [ ] Three\n');
		await tick(manager, file, '#timed\n- [x] Start\n- [ ] Two\n- [ ] Three\n');
		clock.advance(1_000);
		await tick(manager, file, '#timed\n- [x] Start\n- [x] Two\n- [ ] Three\n');

		// The output note now exists (created via vault.create) — simulate the
		// user opening it mid-session, before the second item is checked off.
		const outputPath = [...vault.files.keys()][0];
		assert.ok(outputPath);
		const contentAtOpenTime = vault.files.get(outputPath) as string;
		const outputEditor = editorAccess.open(outputPath, contentAtOpenTime);

		clock.advance(1_000);
		await tick(manager, file, '#timed\n- [x] Start\n- [x] Two\n- [x] Three\n');

		assert.ok(
			outputEditor.getValue().includes('00:00:01 - Three') &&
				outputEditor.getValue().includes('**Total:** 00:00:02'),
			'the per-item line and the finish footer should both land in the open editor',
		);
		assert.equal(
			vault.files.get(outputPath),
			contentAtOpenTime,
			'vault.modify must not have overwritten the note out from under the open editor',
		);
	});

	it('does not reset when the session is stopped early', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await tick(manager, file, '#timed\n- [ ] Start\n- [ ] Two\n- [ ] Three\n');
		await tick(manager, file, '#timed\n- [x] Start\n- [ ] Two\n- [ ] Three\n');
		clock.advance(1_000);
		await tick(manager, file, '#timed\n- [x] Start\n- [x] Two\n- [ ] Three\n');
		const beforeStop = vault.disk.get('Week Plan.md');

		await manager.stopActiveSession();

		assert.equal(
			vault.disk.get('Week Plan.md'),
			beforeStop,
			'stopping early must leave the checklist untouched',
		);
	});

	it('leaves the checklist alone when the setting is off', async () => {
		const { manager } = makeManager(vault, clock, { resetOnCompletion: false });
		const file = sourceFile('Week Plan.md');

		await tick(manager, file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await tick(manager, file, '#timed\n- [x] Start\n- [ ] Two\n');
		clock.advance(1_000);
		await tick(manager, file, '#timed\n- [x] Start\n- [x] Two\n');

		assert.equal(
			vault.disk.get('Week Plan.md'),
			'#timed\n- [x] Start\n- [x] Two\n',
			'the checklist must be left exactly as the last check-off left it',
		);
	});

	it('reports a failure to reset without throwing', async () => {
		const { manager, notices } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await tick(manager, file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await tick(manager, file, '#timed\n- [x] Start\n- [ ] Two\n');
		clock.advance(1_000);
		// Target the reset write specifically — the finish footer write (a
		// separate vault.modify call, on the output note) must be allowed to
		// succeed first.
		vault.failModifyForPath = file.path;
		await tick(manager, file, '#timed\n- [x] Start\n- [x] Two\n');

		assert.ok(notices.some((n) => n.includes('failed to reset checklist in Week Plan.md')));
	});

	it('resets the source checklist before firing the finish notice, so an auto-opened note can never race a not-yet-reset editor', async () => {
		const { manager, notices } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		let noticeCountWhenReset: number | null = null;
		const originalModify = vault.modify.bind(vault);
		vault.modify = async (target, content) => {
			const path = (target as unknown as { path: string }).path;
			if (path === file.path && noticeCountWhenReset === null) {
				noticeCountWhenReset = notices.length;
			}
			await originalModify(target, content);
		};

		await tick(manager, file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await tick(manager, file, '#timed\n- [x] Start\n- [ ] Two\n');
		clock.advance(1_000);
		await tick(manager, file, '#timed\n- [x] Start\n- [x] Two\n');

		const finishIndex = notices.findIndex((n) => n.includes('finished in'));
		assert.notEqual(finishIndex, -1);
		assert.notEqual(noticeCountWhenReset, null, 'the reset write must have happened');
		assert.ok(
			(noticeCountWhenReset ?? Infinity) <= finishIndex,
			'the checklist reset must complete before the finish notice (and its possible auto-open navigation) fires',
		);
	});
});

describe('SessionManager — start item is also the block’s last item', () => {
	let vault: FakeVault;
	let clock: FakeClock;

	beforeEach(() => {
		vault = new FakeVault();
		clock = new FakeClock();
	});

	it('finishes immediately instead of leaving the session running forever', async () => {
		const { manager, notices } = makeManager(vault, clock);
		const file = sourceFile('Quick Task.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Only step\n');
		await manager.handleFileContent(file, '#timed\n- [x] Only step\n');

		assert.equal(manager.hasActiveSession(), false, 'the session must not be left running');
		assert.equal(manager.getActiveTask(), null);
		assert.ok(notices.includes('▶️ "Quick Task" started'));
		assert.ok(
			notices.includes('Checklist timer: stopped (no items timed).'),
			'zero items were timed — starting and ending on the same item',
		);
	});

	it('also finishes immediately when the tagged start item is the last item in a multi-item block', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Note.md');
		const content = '#timed\n- [ ] Prep (not timed)\n- [ ] #start Last step\n';

		await manager.handleFileContent(file, content);
		await manager.handleFileContent(
			file,
			'#timed\n- [ ] Prep (not timed)\n- [x] #start Last step\n',
		);

		assert.equal(manager.hasActiveSession(), false);
	});

	it('still resets the checklist on this immediate finish when resetOnCompletion is on', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Quick Task.md');

		vault.disk.set(file.path, '#timed\n- [ ] Only step\n');
		await manager.handleFileContent(file, '#timed\n- [ ] Only step\n');
		vault.disk.set(file.path, '#timed\n- [x] Only step\n');
		await manager.handleFileContent(file, '#timed\n- [x] Only step\n');

		assert.equal(
			vault.disk.get('Quick Task.md'),
			'#timed\n- [ ] Only step\n',
			'a completed run resets the checklist even when nothing was ever timed',
		);
	});
});

describe('SessionManager — overwrite existing file setting', () => {
	let vault: FakeVault;
	let clock: FakeClock;

	beforeEach(() => {
		vault = new FakeVault();
		clock = new FakeClock();
	});

	it('off (default): fails to write and reports the existing "already exists" error', async () => {
		const { manager, notices } = makeManager(vault, clock, {
			filenameTemplate: '{{title}} timing',
		});
		const file = sourceFile('Week Plan.md');

		vault.files.set('Week Plan timing.md', 'pre-existing content');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');
		clock.advance(1_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n');

		assert.equal(
			vault.files.get('Week Plan timing.md'),
			'pre-existing content',
			'the pre-existing file must be left untouched',
		);
		assert.ok(
			notices.some((n) => n.includes('failed to write to') && n.includes('already exists')),
			'the existing "file already exists" error notice must still fire',
		);
	});

	it('on: fully replaces the existing file’s content rather than appending or erroring', async () => {
		const { manager, notices } = makeManager(vault, clock, {
			overwriteExistingFile: true,
			filenameTemplate: '{{title}} timing',
		});
		const file = sourceFile('Week Plan.md');

		vault.files.set('Week Plan timing.md', 'stale content that must be discarded');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');
		clock.advance(1_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n');

		const content = vault.files.get('Week Plan timing.md');
		assert.ok(
			!content?.includes('stale content'),
			'old content must be completely discarded, not merged or appended to',
		);
		assert.equal(
			content,
			'---\nstart: 1970-01-01T00:00:00\nend: 1970-01-01T00:00:01\ntotal: 00:00:01\nlongest: 00:00:01\n---\n\n' +
				'# Week Plan timing\n\n' +
				'Source: [[Week Plan]]\n\n' +
				'## Slowest first\n\n' +
				'- 00:00:01 - Two\n' +
				'\n**Total:** 00:00:01\n\n' +
				'## In order\n\n' +
				'- 00:00:01 - Two\n',
		);
		assert.ok(
			!notices.some((n) => n.includes('already exists')),
			'overwriting must complete normally, as if the file never existed',
		);
	});

	it('on: writes through an open editor instead of vault.modify when the existing file is open in a pane', async () => {
		const editorAccess = new FakeEditorAccess();
		const { manager } = makeManager(
			vault,
			clock,
			{ overwriteExistingFile: true, filenameTemplate: '{{title}} timing' },
			undefined,
			editorAccess,
		);
		const file = sourceFile('Week Plan.md');

		vault.files.set('Week Plan timing.md', 'stale content');
		const outputEditor = editorAccess.open('Week Plan timing.md', 'stale content');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');
		clock.advance(1_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n');

		assert.ok(
			outputEditor.getValue().includes('00:00:01 - Two') &&
				!outputEditor.getValue().includes('stale content'),
			'the live editor buffer should be fully replaced',
		);
		assert.equal(
			vault.files.get('Week Plan timing.md'),
			'stale content',
			'vault.modify must not have been used while the note is open in an editor',
		);
	});

	it('on: a folder at the resolved path is not mistaken for a file to overwrite', async () => {
		const { manager, notices } = makeManager(vault, clock, {
			overwriteExistingFile: true,
			filenameTemplate: '{{title}} timing',
		});
		const file = sourceFile('Week Plan.md');

		// A folder happens to sit at the exact path the output note would
		// resolve to — getExistingFile must not treat it as an overwritable
		// file, and the normal create() path (which itself fails against a
		// same-path folder) should run instead.
		vault.folders.add('Week Plan timing.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');
		clock.advance(1_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n');

		assert.equal(
			vault.files.has('Week Plan timing.md'),
			false,
			'a folder must never be silently overwritten as if it were the output file',
		);
		assert.ok(
			notices.some((n) => n.includes('failed to write to')),
			'the collision should surface as the normal write-failure notice, not a silent success',
		);
	});

	it('off: does not affect a session whose output file does not yet exist', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');
		clock.advance(1_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n');

		assert.ok(vault.findContent('Week Plan timing')?.includes('00:00:01 - Two'));
	});
});

describe('SessionManager — output path normalization', () => {
	it('runs the configured output folder and final path through normalizePath', async () => {
		const vault = new FakeVault();
		const clock = new FakeClock();
		const normalizeCalls: string[] = [];
		// Stand-in for Obsidian's normalizePath: strips a trailing slash the
		// user might type into the output folder setting.
		const fakeNormalizePath = (path: string) => {
			normalizeCalls.push(path);
			return path.replace(/\/+$/, '');
		};
		const { manager } = makeManager(
			vault,
			clock,
			{ outputFolder: 'Timing Logs/' },
			fakeNormalizePath,
		);
		const file = sourceFile('Note.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');
		clock.advance(1_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n');

		assert.ok(normalizeCalls.includes('Timing Logs/'), 'the raw folder should be normalized');
		assert.ok(vault.folders.has('Timing Logs'), 'the trailing slash must be stripped before use');
		assert.ok(
			[...vault.files.keys()][0]?.startsWith('Timing Logs/'),
			'the final output path must use the normalized folder',
		);
	});
});
