import type { TFile } from 'obsidian';
import {
	ChecklistBlock,
	ChecklistItem,
	findTimedBlocks,
	resolveStartIndex,
	uncheckBlock,
} from './utils/checklist';
import { formatDuration, renderFilename } from './utils/format';
import { ChecklistTimerSettings } from './settings-schema';
import { EditorAccess, Notifier, NotifyOptions, VaultAccess } from './timer-port';

// Obsidian's default notice timeout is short (~5s); the finish notice is a
// clickable CTA to open the result note, so give the user more time to
// notice and click it.
const FINISH_NOTICE_DURATION_MS = 10_000;

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
	// Snapshot of the block's items as of the last processed check-off (or
	// session start), including their checked state — the source of truth
	// getActiveTask() reads from to find whichever item is currently
	// accumulating time. Kept as raw items rather than a cached "current item
	// name" so an out-of-order check-off (e.g. a bulk edit, or another
	// plugin's sidebar checking a later item first) is reflected correctly:
	// the active item is derived from actual checked state, not an
	// assumption that items are always checked in sequence.
	items: ChecklistItem[];
	startIndex: number;
}

// Public snapshot of the item currently being timed, for status bar display.
export interface ActiveTask {
	name: string;
	// Timestamp (same clock as the `now` constructor arg) the current item
	// started accumulating time — i.e. ActiveSession.lastEventTime.
	startTime: number;
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
		// Fired whenever a session starts or ends — a "something changed,
		// refresh your display" signal rather than a message to show; the
		// active task timer (main.ts) derives what to render from
		// getActiveTask() instead.
		private readonly onStatusChange: () => void,
		private readonly notify: Notifier,
		private readonly now: () => number = Date.now,
		// Obsidian's normalizePath() — cleans user-typed folder paths (stray
		// slashes, platform separators, etc.) before they hit the filesystem.
		private readonly normalizePath: (path: string) => string = (path) => path,
		// Defaults to "nothing is open in an editor" so existing call sites
		// (and tests that don't care about this) don't need to supply one.
		private readonly editorAccess: EditorAccess = { getOpenEditor: () => null },
	) {}

	updateSettings(settings: ChecklistTimerSettings) {
		this.settings = settings;
	}

	hasActiveSession(): boolean {
		return this.activeSession !== null;
	}

	getActiveTask(): ActiveTask | null {
		const session = this.activeSession;
		if (!session) return null;
		// First still-unchecked item after the start item — i.e. whichever
		// item's check-off will next stop the clock. Returns null once none
		// remain (the block is done but finishSession hasn't run yet), so the
		// status bar hides instead of flashing a stale/misleading name.
		const nextItem = session.items.find(
			(item, index) => index > session.startIndex && !item.checked,
		);
		if (!nextItem) return null;
		return { name: nextItem.text, startTime: session.lastEventTime };
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
					this.notify(
						`Checklist timer: "${session.title}" is already being timed.`,
						this.resultFileOptions(session),
					);
					return;
				}
				if (this.settings.autoSwitchSessions) {
					this.notify(
						`Checklist timer: starting a new checklist — stopping "${session.title}" first.`,
						this.resultFileOptions(session),
					);
					await this.finishSession('stopped');
				} else {
					this.notify(
						`Checklist timer: "${session.title}" is already being timed — this checklist won't be tracked. Turn on auto-switch in settings to switch automatically instead.`,
						this.resultFileOptions(session),
					);
					return;
				}
			}
			this.startSession(file, block, startIndex);
			// The start item can also be the block's last item (e.g. a
			// single-item checklist) — without this, the session would start
			// but nothing would ever trigger its finish, since the "last item
			// checked" check below only runs for indices *after* startIndex.
			if (startIndex === block.items.length - 1) {
				await this.finishSession('completed', file, block);
			}
			return;
		}

		if (!session || !isSameBlock) {
			if (session) {
				this.notify(
					`Checklist timer: not tracked — "${session.title}" is currently being timed.`,
					this.resultFileOptions(session),
				);
			}
			return;
		}

		const item = block.items[index];
		if (!item) return;

		const duration = this.now() - session.lastEventTime;
		session.lastEventTime = this.now();
		session.results.push({ text: item.text, durationMs: duration });
		session.items = block.items;

		const wrote = await this.appendItem(session, item.text, duration);
		if (wrote) {
			this.notify(`⏱ ${item.text}: ${formatDuration(duration)}`, this.resultFileOptions(session));
		}

		if (index === block.items.length - 1) {
			await this.finishSession('completed', file, block);
		}
	}

	async stopActiveSession() {
		if (!this.activeSession) {
			this.notify('Checklist timer: no active timer.');
			return;
		}
		await this.finishSession('stopped');
	}

	private startSession(file: TFile, block: ChecklistBlock, startIndex: number) {
		const title = file.basename;
		this.activeSession = {
			filePath: file.path,
			blockStartLine: block.startLine,
			lastEventTime: this.now(),
			title,
			outputPath: this.resolveOutputPath(title),
			outputFile: null,
			results: [],
			items: block.items,
			startIndex,
		};
		this.notify(`▶️ "${title}" started`);
		this.onStatusChange();
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

	// Vault-relative path (no extension) for the Obsidian [[wikilink]] back to
	// the checklist note that was timed — using the full path rather than just
	// the title avoids resolving to the wrong note if another note elsewhere
	// in the vault happens to share the same basename.
	private sourceLinkTarget(session: ActiveSession): string {
		return session.filePath.replace(/\.md$/, '');
	}

	private async appendItem(
		session: ActiveSession,
		text: string,
		durationMs: number,
	): Promise<boolean> {
		const line = `- ${formatDuration(durationMs)}: ${text}\n`;
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
				const header = `# ${session.title} timing\n\nSource: [[${this.sourceLinkTarget(session)}]]\n\n## In order\n\n`;
				const existing = this.settings.overwriteExistingFile
					? this.vault.getExistingFile(session.outputPath)
					: null;
				if (existing) {
					// Fully replace — the mutate callback ignores `current` rather than
					// appending to it, so any prior content is discarded. Still routed
					// through writeNoteContent (not a raw vault.modify) so a same-path
					// note already open in an editor is overwritten there too,
					// consistent with every other write path — see CLAUDE.md. skipRead
					// avoids reading the very content this call is about to discard.
					await this.writeNoteContent(existing, () => header + line, { skipRead: true });
					session.outputFile = existing;
				} else {
					session.outputFile = await this.vault.create(session.outputPath, header + line);
				}
			} else {
				await this.writeNoteContent(session.outputFile, (current) => current + line);
			}
			return true;
		} catch (err) {
			this.notify(
				`Checklist timer: failed to write to ${session.outputPath} (${String(err)})`,
				this.resultFileOptions(session),
			);
			return false;
		}
	}

	private async finishSession(
		reason: 'completed' | 'stopped',
		sourceFile?: TFile,
		sourceBlock?: ChecklistBlock,
	) {
		const session = this.activeSession;
		if (!session) return;
		this.activeSession = null;
		this.onStatusChange();

		const outputFile = session.outputFile;
		if (!outputFile) {
			this.notify('Checklist timer: stopped (no items timed).');
		} else {
			const suffix = reason === 'stopped' ? ' (stopped early)' : '';
			const totalMs = session.results.reduce((sum, result) => sum + result.durationMs, 0);
			const slowestFirst = [...session.results].sort((a, b) => b.durationMs - a.durationMs);
			const slowestFirstLines = slowestFirst
				.map((result) => `- ${formatDuration(result.durationMs)}: ${result.text}`)
				.join('\n');
			const footer =
				`\n**Total:** ${formatDuration(totalMs)}${suffix}\n\n` +
				`## Slowest first\n\n${slowestFirstLines}\n`;
			try {
				await this.writeNoteContent(outputFile, (current) => current + footer);
				this.notify(
					`✅ "${session.title}" finished in ${formatDuration(totalMs)}${suffix} — click to open results`,
					{ filePath: outputFile.path, durationMs: FINISH_NOTICE_DURATION_MS },
				);
			} catch (err) {
				this.notify(
					`Checklist timer: failed to write total to ${session.outputPath} (${String(err)})`,
					{ filePath: outputFile.path },
				);
			}
		}

		// Only a natural finish (last item checked) resets the checklist — a
		// manual stop means the run was intentionally left incomplete, so the
		// checklist is left as-is rather than blanking out real progress. Runs
		// even when nothing was ever timed (e.g. the start item is also the
		// block's last item), since that's still a completed run.
		if (reason === 'completed' && this.settings.resetOnCompletion && sourceFile && sourceBlock) {
			await this.resetChecklistBlock(sourceFile, sourceBlock);
		}
	}

	private async resetChecklistBlock(file: TFile, block: ChecklistBlock) {
		try {
			await this.writeNoteContent(file, (current) => uncheckBlock(current, block));
		} catch (err) {
			this.notify(`Checklist timer: failed to reset checklist in ${file.path} (${String(err)})`);
		}
	}

	// Shared write path for both the output note (appendItem/finishSession)
	// and resetting the source checklist. When the target note is open in an
	// editor, mutate *that* buffer directly instead of writing to disk out
	// from under it — see the EditorAccess doc comment in timer-port.ts for
	// why a raw vault.modify() is unsafe in that case. Always reads the
	// live/current content (from the editor, or fresh off disk) rather than a
	// stale snapshot, so callers never need to thread content through.
	private async writeNoteContent(
		file: TFile,
		mutate: (current: string) => string,
		// skipRead: for a caller whose mutate() ignores `current` entirely
		// (a full overwrite) — skips the disk read of content that's about to
		// be discarded anyway. Only safe when no editor has the file open,
		// which is exactly the branch below that would otherwise call
		// vault.read(); the editor branch already gets its content for free
		// via editor.getValue(), so it's unaffected either way.
		{ skipRead = false }: { skipRead?: boolean } = {},
	): Promise<void> {
		const editor = this.editorAccess.getOpenEditor(file.path);
		if (editor) {
			editor.setValue(mutate(editor.getValue()));
			return;
		}
		const current = skipRead ? '' : await this.vault.read(file);
		await this.vault.modify(file, mutate(current));
	}

	// Only worth attaching a click-to-open target once the output file
	// actually exists — it's created lazily on the first timed item (see
	// ActiveSession.outputFile), so early-session notices have nothing to
	// point to yet.
	private resultFileOptions(session: ActiveSession): NotifyOptions | undefined {
		// .path (not the once-computed outputPath) so a click still resolves
		// correctly even if the note was renamed/moved mid-session — Obsidian
		// updates a TFile's .path in place rather than issuing a new object.
		return session.outputFile ? { filePath: session.outputFile.path } : undefined;
	}
}
