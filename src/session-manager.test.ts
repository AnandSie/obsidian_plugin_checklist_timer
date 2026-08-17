import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TFile } from 'obsidian';
import { SessionManager } from './session-manager';
import { DEFAULT_SETTINGS, ChecklistTimerSettings } from './settings-schema';
import type { VaultAccess } from './timer-port';

// In-memory stand-in for Obsidian's Vault — real TFile objects are opaque to
// SessionManager (it never inspects them beyond passing them back into
// append()), so a plain object with a `path` is a faithful enough double.
class FakeVault implements VaultAccess {
	files = new Map<string, string>();
	folders = new Set<string>();

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
		const path = (file as unknown as { path: string }).path;
		const existing = this.files.get(path);
		if (existing === undefined) throw new Error(`append to missing file: ${path}`);
		this.files.set(path, existing + content);
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
) {
	const notices: string[] = [];
	const statuses: string[] = [];
	const settings: ChecklistTimerSettings = { ...DEFAULT_SETTINGS, ...overrides };
	const manager = new SessionManager(
		vault,
		settings,
		(status) => statuses.push(status),
		(message) => notices.push(message),
		clock.now,
	);
	return { manager, notices, statuses };
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
		assert.ok(notices.includes('Checklist timer: started.'));
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
		assert.ok(notices.some((n) => n.includes('saved timing to')));
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
		assert.ok(notices.some((n) => n.includes('saved timing to')));
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
		assert.ok(notices.some((n) => n.includes('saved timing to')), 'A must be saved');
		assert.ok(notices.includes('Checklist timer: started.'), 'B must start');

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
