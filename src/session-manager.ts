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
	results: TimedResult[];
}

// Tracks at most one running session across the whole vault (see CLAUDE.md:
// "each item is only one item at a time in progress").
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
			this.activeSession = {
				filePath: file.path,
				blockStartLine: block.startLine,
				lastEventTime: now,
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
		session.results.push({ text: item.text, durationMs: duration });
		session.lastEventTime = now;

		if (index === block.items.length - 1) {
			await this.finishSession(file);
		}
	}

	async stopActiveSession() {
		if (!this.activeSession) {
			new Notice('Checklist timer: no active timer.');
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(this.activeSession.filePath);
		if (file instanceof TFile) {
			await this.finishSession(file);
		} else {
			this.activeSession = null;
			this.onStatusChange('');
		}
	}

	private async finishSession(file: TFile) {
		const session = this.activeSession;
		if (!session) return;
		this.activeSession = null;
		this.onStatusChange('');

		if (session.results.length === 0) {
			new Notice('Checklist timer: stopped (no items timed).');
			return;
		}

		await this.writeOutput(file, session.results);
	}

	private async writeOutput(file: TFile, results: TimedResult[]) {
		const title = file.basename;
		const totalMs = results.reduce((sum, result) => sum + result.durationMs, 0);
		const lines = results.map(
			(result) => `- ${result.text}: ${formatDuration(result.durationMs)}`,
		);
		const content = [
			`# Checklist timing — ${title}`,
			'',
			`Total: ${formatDuration(totalMs)}`,
			'',
			...lines,
			'',
		].join('\n');

		const filename = renderFilename(this.settings.filenameTemplate, title);
		const folder = this.settings.outputFolder.trim();
		const path = folder ? `${folder}/${filename}.md` : `${filename}.md`;

		if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder).catch(() => {});
		}

		try {
			await this.app.vault.create(path, content);
			new Notice(`Checklist timer: saved timing to ${path}`);
		} catch (err) {
			new Notice(`Checklist timer: failed to write ${path} (${String(err)})`);
		}
	}
}
