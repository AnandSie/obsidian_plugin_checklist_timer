import { App, Notice, TFile } from 'obsidian';
import { ChecklistBlock, findTimedBlocks, resolveStartIndex } from './utils/checklist';
import { formatDuration, renderFilename } from './utils/format';
import { ChecklistTimerSettings } from './settings';

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
// "each item is only one item at a time in progress"). The output note is
// written incrementally, one item at a time, so progress survives even if
// the checklist is never finished (see CLAUDE.md: no session resume, but
// completed items shouldn't be lost either).
export class SessionManager {
	private activeSession: ActiveSession | null = null;
	private readonly blockStateCache = new Map<string, boolean[]>();

	constructor(
		private readonly app: App,
		private settings: ChecklistTimerSettings,
		private readonly onStatusChange: (status: string) => void,
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
		const now = Date.now();

		if (index < startIndex) return;

		if (index === startIndex) {
			if (this.activeSession) {
				new Notice(
					`Checklist timer: a timer is already running in "${this.activeSession.filePath}" — ignoring new start.`,
				);
				return;
			}
			const title = file.basename;
			this.activeSession = {
				filePath: file.path,
				blockStartLine: block.startLine,
				lastEventTime: now,
				title,
				outputPath: this.resolveOutputPath(title),
				outputFile: null,
				results: [],
			};
			new Notice('Checklist timer: started.');
			this.onStatusChange('Checklist timer: running');
			return;
		}

		const session = this.activeSession;
		if (
			!session ||
			session.filePath !== file.path ||
			session.blockStartLine !== block.startLine
		) {
			// No active session for this block — nothing to attribute time to.
			return;
		}

		const item = block.items[index];
		if (!item) return;

		const duration = now - session.lastEventTime;
		session.lastEventTime = now;
		session.results.push({ text: item.text, durationMs: duration });

		await this.appendItem(session, item.text, duration);

		if (index === block.items.length - 1) {
			await this.finishSession('completed');
		}
	}

	async stopActiveSession() {
		if (!this.activeSession) {
			new Notice('Checklist timer: no active timer.');
			return;
		}
		await this.finishSession('stopped');
	}

	private resolveOutputPath(title: string): string {
		const filename = renderFilename(this.settings.filenameTemplate, title);
		const folder = this.settings.outputFolder.trim();
		return folder ? `${folder}/${filename}.md` : `${filename}.md`;
	}

	private async appendItem(session: ActiveSession, text: string, durationMs: number) {
		const line = `- ${text}: ${formatDuration(durationMs)}\n`;
		try {
			if (!session.outputFile) {
				const folder = this.settings.outputFolder.trim();
				if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
					await this.app.vault.createFolder(folder).catch(() => {});
				}
				const header = `# Checklist timing — ${session.title}\n\n`;
				session.outputFile = await this.app.vault.create(
					session.outputPath,
					header + line,
				);
			} else {
				await this.app.vault.append(session.outputFile, line);
			}
		} catch (err) {
			new Notice(
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
			new Notice('Checklist timer: stopped (no items timed).');
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
			await this.app.vault.append(session.outputFile, footer);
			new Notice(`Checklist timer: saved timing to ${session.outputPath}`);
		} catch (err) {
			new Notice(
				`Checklist timer: failed to write total to ${session.outputPath} (${String(err)})`,
			);
		}
	}
}
