import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TFile } from 'obsidian';
import { SessionManager } from './session-manager';
import { DEFAULT_SETTINGS, ChecklistTimerSettings } from './settings-schema';
import type { NotifyOptions, VaultAccess } from './timer-port';

// In-memory stand-in for Obsidian's Vault — real TFile objects are opaque to
// SessionManager (it never inspects them beyond passing them back into
// append()), so a plain object with a `path` is a faithful enough double.
class FakeVault implements VaultAccess {
	files = new Map<string, string>();
	folders = new Set<string>();
	// Separate from `files` (which models the created/appended output note) —
	// tracks writes back to a *source* checklist note, e.g. the reset feature
	// unchecking its items. Keyed by path.
	modified = new Map<string, string>();
	// Test hook: makes the next append() call reject, to exercise write-failure paths.
	failNextAppend = false;
	// Test hook: makes the next modify() call reject, to exercise reset-failure paths.
	failNextModify = false;

	getAbstractFileByPath(path: string): unknown {
		if (this.files.has(path) || this.folders.has(path)) return { path };
		return null;
	}

	async createFolder(path: string): Promise<unknown> {
		this.folders.add(path);
		return { path };
	}

	async create(path: string, content: string): Promise<TFile> {
		if (this.files.has(path)) throw new Error(`already exists: ${path}`);
		this.files.set(path, content);
		return { path } as unknown as TFile;
	}

	async append(file: TFile, content: string): Promise<void> {
		if (this.failNextAppend) {
			this.failNextAppend = false;
			throw new Error('simulated disk error');
		}
		const path = (file as unknown as { path: string }).path;
		const existing = this.files.get(path);
		if (existing === undefined) throw new Error(`append to missing file: ${path}`);
		this.files.set(path, existing + content);
	}

	async modify(file: TFile, content: string): Promise<void> {
		if (this.failNextModify) {
			this.failNextModify = false;
			throw new Error('simulated disk error');
		}
		const path = (file as unknown as { path: string }).path;
		this.modified.set(path, content);
	}

	// Test helper: find the single stored file whose path contains `needle`.
	findContent(needle: string): string | undefined {
		const path = [...this.files.keys()].find((p) => p.includes(needle));
		return path ? this.files.get(path) : undefined;
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
) {
	const notices: string[] = [];
	const noticeOptions: (NotifyOptions | undefined)[] = [];
	const statuses: string[] = [];
	const settings: ChecklistTimerSettings = { ...DEFAULT_SETTINGS, ...overrides };
	const manager = new SessionManager(
		vault,
		settings,
		(status) => statuses.push(status),
		(message, options) => {
			notices.push(message);
			noticeOptions.push(options);
		},
		clock.now,
		normalizePath,
	);
	return { manager, notices, noticeOptions, statuses };
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
			'# Checklist timing — Week Plan\n\n- Two: 00:00:05\n',
		);

		clock.advance(3_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n- [x] Three\n');

		assert.equal(
			vault.findContent('Week Plan timing'),
			'# Checklist timing — Week Plan\n\n' +
				'- Two: 00:00:05\n' +
				'- Three: 00:00:03\n' +
				'\nTotal: 00:00:08\n\n' +
				'## Sorted by duration (slowest first)\n\n' +
				'- Two: 00:00:05\n' +
				'- Three: 00:00:03\n',
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
		assert.ok(content?.includes('Total: 00:00:10 (stopped early)'));
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
			noticeOptions[finishIndex]?.filePath,
			outputPath,
			'the finish notice should carry the output path so it can be opened on click',
		);
		assert.ok(
			(noticeOptions[finishIndex]?.durationMs ?? 0) > 5000,
			'the finish notice should stay visible longer than Obsidian’s default',
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
		assert.ok(notices.some((n) => n.includes('⏱ Two:')));

		// ...but the append for the second item fails.
		vault.failNextAppend = true;
		clock.advance(1_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n- [x] Three\n');

		assert.ok(
			notices.some((n) => n.includes('failed to write to')),
			'the failure must be reported',
		);
		assert.ok(
			!notices.some((n) => n.includes('⏱ Three:')),
			'no success-looking notice should fire for an item that was never actually saved',
		);
	});

	it('stopActiveSession with no session running just notifies', async () => {
		const { manager, notices } = makeManager(vault, clock);
		await manager.stopActiveSession();
		assert.deepEqual(notices, ['Checklist timer: no active timer.']);
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
		const { manager, notices } = makeManager(vault, clock, { autoSwitchSessions: true });
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
		assert.ok(notices.some((n) => n.includes('finished in')), 'A must be saved');
		assert.ok(notices.includes('▶️ "Checklist B" started'), 'B must start');

		const aContent = vault.findContent('Checklist A timing');
		assert.ok(aContent?.includes('Total: 00:00:02 (stopped early)'));
		assert.ok(!aContent?.includes('Three'), 'A never reached its last item');

		// B keeps timing normally after the switch.
		clock.advance(1_000);
		await manager.handleFileContent(fileB, '#timed\n- [x] Kickoff\n- [x] Wrap up\n');
		const bContent = vault.findContent('Checklist B timing');
		assert.ok(bContent?.includes('Total: 00:00:01\n'));
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
		assert.ok(aContent?.includes('Total: 00:00:06\n'));
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
			noticeOptions[notTrackedYetIndex]?.filePath,
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
		assert.equal(noticeOptions[notTrackedIndex]?.filePath, outputPath);
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
		assert.ok(content?.includes('Two: 00:00:01'), 'the original session must still be intact');
	});
});

describe('SessionManager — reset checklist on completion', () => {
	let vault: FakeVault;
	let clock: FakeClock;

	beforeEach(() => {
		vault = new FakeVault();
		clock = new FakeClock();
	});

	it('unchecks every item (including pre-start ones) once the session finishes naturally', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		const content = '#timed\n- [x] Prep\n- [ ] #start Kickoff\n- [ ] Two\n';
		await manager.handleFileContent(file, content);
		await manager.handleFileContent(
			file,
			'#timed\n- [x] Prep\n- [x] #start Kickoff\n- [ ] Two\n',
		);
		clock.advance(1_000);
		await manager.handleFileContent(
			file,
			'#timed\n- [x] Prep\n- [x] #start Kickoff\n- [x] Two\n',
		);

		assert.equal(
			vault.modified.get('Week Plan.md'),
			'#timed\n- [ ] Prep\n- [ ] #start Kickoff\n- [ ] Two\n',
			'the source note should have every box in the block unchecked, pre-start items included',
		);
	});

	it('does not reset when the session is stopped early', async () => {
		const { manager } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n- [ ] Three\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n- [ ] Three\n');
		clock.advance(1_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n- [ ] Three\n');

		await manager.stopActiveSession();

		assert.equal(vault.modified.size, 0, 'stopping early must leave the checklist untouched');
	});

	it('leaves the checklist alone when the setting is off', async () => {
		const { manager } = makeManager(vault, clock, { resetOnCompletion: false });
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');
		clock.advance(1_000);
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n');

		assert.equal(vault.modified.size, 0);
	});

	it('reports a failure to reset without throwing', async () => {
		const { manager, notices } = makeManager(vault, clock);
		const file = sourceFile('Week Plan.md');

		await manager.handleFileContent(file, '#timed\n- [ ] Start\n- [ ] Two\n');
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [ ] Two\n');
		clock.advance(1_000);
		vault.failNextModify = true;
		await manager.handleFileContent(file, '#timed\n- [x] Start\n- [x] Two\n');

		assert.ok(notices.some((n) => n.includes('failed to reset checklist in Week Plan.md')));
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
