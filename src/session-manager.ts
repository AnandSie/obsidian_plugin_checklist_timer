import type { TFile } from 'obsidian';
import { ChecklistBlock, findTimedBlocks, resolveStartIndex } from './utils/checklist';
import { formatDuration, renderFilename } from './utils/format';
import { ChecklistTimerSettings } from './settings-schema';
import { Notifier, VaultAccess } from './timer-port';

interface TimedResult {
	text: string;
	durationMs: number;
}

interface ActiveSession {
	filePath: string;
	blockStartLine: number;
	lastEventTime: number;
	title: string;
	outputPath: string;
	// null until the first item is timed — the output note is created lazily
	// so a session with zero timed items leaves no stray file behind.
	outputFile: TFile | null;
	// Kept in memory (in addition to being appended line-by-line) so the
	// finish footer can add a slowest-first summary. If Obsidian crashes
	// before finish, this in-memory copy is lost, but the already-appended
	// lines in the note are not — see CLAUDE.md.
	results: TimedResult[];
}

// Tracks at most one running session across the whole vault (see CLAUDE.md:
// "only one timer active at a time"). The output note is written
// incrementally, one item at a time, so progress survives even if the
// checklist is never finished. Starting a second timed checklist while one
// is running either auto-switches to it or is blocked, per settings — see
// handleItemChecked.
export class SessionManager {
	private activeSession: ActiveSession | null = null;
	private readonly blockStateCache = new Map<string, boolean[]>();

	constructor(
		private readonly vault: VaultAccess,
		private settings: ChecklistTimerSettings,
		private readonly onStatusChange: (status: string) => void,
		private readonly notify: Notifier,
		private readonly now: () => number = Date.now,
		// Obsidian's normalizePath() — cleans user-typed folder paths (stray
		// slashes, platform separators, etc.) before they hit the filesystem.
		private readonly normalizePath: (path: string) => string = (path) => path,
	) {}

	updateSettings(settings: ChecklistTimerSettings) {
		this.settings = settings;
	}

	hasActiveSession(): boolean {
		return this.activeSession !== null;
	}

	async handleFileContent(file: TFile, content: string) {
		const blocks = findTimedBlocks(content, this.settings.timedTag);
		for (const block of blocks) {
			await this.processBlock(file, block);
		}
	}

	private blockKey(file: TFile, block: ChecklistBlock): string {
		return `${file.path}#${block.startLine}`;
	}

	private async processBlock(file: TFile, block: ChecklistBlock) {
		const key = this.blockKey(file, block);
		const currentState = block.items.map((item) => item.checked);
		const previousState = this.blockStateCache.get(key);
		this.blockStateCache.set(key, currentState);

		// First time we've seen this block — don't fire on pre-existing checks
		// (no session resume by design, see CLAUDE.md).
		if (!previousState) return;

		const newlyChecked: number[] = [];
		currentState.forEach((checked, index) => {
			if (checked && !previousState[index]) newlyChecked.push(index);
		});

		const startIndex = resolveStartIndex(block, this.settings.startTag);
		for (const index of newlyChecked) {
			await this.handleItemChecked(file, block, index, startIndex);
		}
	}

	private async handleItemChecked(
		file: TFile,
		block: ChecklistBlock,
		index: number,
		startIndex: number,
	) {
		if (index < startIndex) return;

		const session = this.activeSession;
		const isSameBlock =
			session !== null &&
			session.filePath === file.path &&
			session.blockStartLine === block.startLine;

		if (index === startIndex) {
			if (session) {
				if (isSameBlock) {
					this.notify(`Checklist timer: "${session.title}" is already being timed.`);
					return;
				}
				if (this.settings.autoSwitchSessions) {
					this.notify(
						`Checklist timer: starting a new checklist — stopping "${session.title}" first.`,
					);
					await this.finishSession('stopped');
				} else {
					this.notify(
						`Checklist timer: "${session.title}" is already being timed — this checklist won't be tracked. Turn on auto-switch in settings to switch automatically instead.`,
					);
					return;
				}
			}
			this.startSession(file, block);
			return;
		}

		if (!session || !isSameBlock) {
			if (session) {
				this.notify(
					`Checklist timer: not tracked — "${session.title}" is currently being timed.`,
				);
			}
			return;
		}

		const item = block.items[index];
		if (!item) return;

		const duration = this.now() - session.lastEventTime;
		session.lastEventTime = this.now();
		session.results.push({ text: item.text, durationMs: duration });

		await this.appendItem(session, item.text, duration);

		if (index === block.items.length - 1) {
			await this.finishSession('completed');
		}
	}

	async stopActiveSession() {
		if (!this.activeSession) {
			this.notify('Checklist timer: no active timer.');
			return;
		}
		await this.finishSession('stopped');
	}

	private startSession(file: TFile, block: ChecklistBlock) {
		const title = file.basename;
		this.activeSession = {
			filePath: file.path,
			blockStartLine: block.startLine,
			lastEventTime: this.now(),
			title,
			outputPath: this.resolveOutputPath(title),
			outputFile: null,
			results: [],
		};
		this.notify('Checklist timer: started.');
		this.onStatusChange(`Checklist timer: running (${title})`);
	}

	private normalizedFolder(): string {
		const folder = this.settings.outputFolder.trim();
		return folder ? this.normalizePath(folder) : '';
	}

	private resolveOutputPath(title: string): string {
		const filename = renderFilename(this.settings.filenameTemplate, title);
		const folder = this.normalizedFolder();
		const rawPath = folder ? `${folder}/${filename}.md` : `${filename}.md`;
		return this.normalizePath(rawPath);
	}

	private async appendItem(session: ActiveSession, text: string, durationMs: number) {
		const line = `- ${text}: ${formatDuration(durationMs)}\n`;
		try {
			if (!session.outputFile) {
				const folder = this.normalizedFolder();
				if (folder && !this.vault.getAbstractFileByPath(folder)) {
					try {
						await this.vault.createFolder(folder);
					} catch {
						// Folder may already exist (e.g. a race with another writer,
						// or our existence check was briefly stale) — harmless.
					}
				}
				const header = `# Checklist timing — ${session.title}\n\n`;
				session.outputFile = await this.vault.create(session.outputPath, header + line);
			} else {
				await this.vault.append(session.outputFile, line);
			}
		} catch (err) {
			this.notify(
				`Checklist timer: failed to write to ${session.outputPath} (${String(err)})`,
			);
		}
	}

	private async finishSession(reason: 'completed' | 'stopped') {
		const session = this.activeSession;
		if (!session) return;
		this.activeSession = null;
		this.onStatusChange('');

		if (!session.outputFile) {
			this.notify('Checklist timer: stopped (no items timed).');
			return;
		}

		const suffix = reason === 'stopped' ? ' (stopped early)' : '';
		const totalMs = session.results.reduce((sum, result) => sum + result.durationMs, 0);
		const slowestFirst = [...session.results].sort((a, b) => b.durationMs - a.durationMs);
		const slowestFirstLines = slowestFirst
			.map((result) => `- ${result.text}: ${formatDuration(result.durationMs)}`)
			.join('\n');
		const footer =
			`\nTotal: ${formatDuration(totalMs)}${suffix}\n\n` +
			`## Sorted by duration (slowest first)\n\n${slowestFirstLines}\n`;
		try {
			await this.vault.append(session.outputFile, footer);
			this.notify(`Checklist timer: saved timing to ${session.outputPath}`);
		} catch (err) {
			this.notify(
				`Checklist timer: failed to write total to ${session.outputPath} (${String(err)})`,
			);
		}
	}
}
