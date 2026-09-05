import type { TFile } from 'obsidian';
import {
	ChecklistBlock,
	ChecklistItem,
	findTimedBlocks,
	resolveStartIndex,
	uncheckBlock,
} from './utils/checklist';
import { formatDuration, formatTimestamp, renderFilename } from './utils/format';
import { OUTPUT_NOTE_MARKER } from './utils/duration-bars';
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
	// When the session itself started (the start item's check-off) — kept
	// separate from lastEventTime, which advances on every subsequent
	// check-off, so the output note's frontmatter `start` property still
	// reflects the true session start even once the output file is created
	// later, on the *first timed* item.
	startTime: number;
	lastEventTime: number;
	title: string;
	outputPath: string;
	// null until the first item is timed — the output note is created lazily
	// so a session with zero timed items leaves no stray file behind.
	outputFile: TFile | null;
	// Kept in memory (in addition to being appended line-by-line) so the
	// finish write can add a slowest-first summary. If Obsidian crashes
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
	// Timestamp (same clock as `now`) the session was paused, or null while
	// running. While paused the in-progress item stops accumulating time;
	// resumeSession (or the next check-off) folds the paused span out of
	// lastEventTime so time spent paused is never attributed to any item.
	pausedAt: number | null;
	// Cumulative length of every *resolved* pause (each folded span, summed by
	// applyPauseOffset). finishSession subtracts this from lastEventTime when
	// writing the `end` frontmatter property, so `end - start` stays equal to
	// `total` — the invariant the output-format section of CLAUDE.md relies on
	// — even across pauses. A still-open pause isn't counted (it lies after
	// the last check-off, so it doesn't affect `end` anyway).
	pausedMs: number;
}

// Public snapshot of the item currently being timed, for status bar display.
export interface ActiveTask {
	name: string;
	// Timestamp (same clock as the `now` constructor arg) the current item
	// started accumulating time — i.e. ActiveSession.lastEventTime.
	startTime: number;
	// The timestamp the session was paused, or null while running. The status
	// bar reads this to freeze the elapsed display (and show a paused
	// indicator) instead of ticking up while the user is away.
	pausedAt: number | null;
}

// Tracks at most one running session across the whole vault (see CLAUDE.md:
// "only one timer active at a time"). The output note is written
// incrementally, one item at a time, so progress survives even if the
// checklist is never finished. Starting a second timed checklist while one
// is running either auto-switches to it or is blocked, per settings — see
// handleItemChecked.
export class SessionManager {
	private activeSession: ActiveSession | null = null;
	// Per-block snapshot from the previous parse — the baseline the positional
	// check-off diff compares against. Item text is kept alongside the checked
	// flag so processBlock can tell a genuine check-off (same slot, text
	// unchanged, flag flipped) from the list shifting under it (an insert,
	// delete, or rename that moves every slot below it).
	private readonly blockStateCache = new Map<string, { checked: boolean; text: string }[]>();
	// Block keys we've already shown the "checklist changed while timing" notice
	// for. handleFileContent runs per editor-change (≈ per keystroke), so without
	// this a single mid-run edit — typing a new item's name, renaming one —
	// stacks a notice per keystroke. Cleared for a block the moment it parses
	// without a shift again, so a later, separate edit warns afresh.
	private readonly blockShiftNotified = new Set<string>();

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
		return {
			name: nextItem.text,
			startTime: session.lastEventTime,
			pausedAt: session.pausedAt,
		};
	}

	// Freezes the clock for the item currently being timed. Time between now
	// and the matching resume (or the next check-off) is dropped rather than
	// attributed to that item — see applyPauseOffset. A no-op notice fires if
	// nothing is running or the session is already paused.
	pauseSession() {
		const session = this.activeSession;
		if (!session) {
			this.notify('Checklist timer: no active timer to pause.');
			return;
		}
		if (session.pausedAt !== null) {
			this.notify(
				`Checklist timer: "${session.title}" is already paused.`,
				this.resultFileOptions(session),
			);
			return;
		}
		session.pausedAt = this.now();
		this.notify(`⏸️ "${session.title}" paused`, this.resultFileOptions(session));
		this.onStatusChange();
	}

	// Restarts the clock after pauseSession, folding the paused span out so
	// the in-progress item isn't charged for time the user was away.
	resumeSession() {
		const session = this.activeSession;
		if (!session) {
			this.notify('Checklist timer: no active timer to resume.');
			return;
		}
		if (session.pausedAt === null) {
			this.notify(
				`Checklist timer: "${session.title}" is not paused.`,
				this.resultFileOptions(session),
			);
			return;
		}
		this.applyPauseOffset(session);
		this.notify(`▶️ "${session.title}" resumed`, this.resultFileOptions(session));
		this.onStatusChange();
	}

	// Shifts lastEventTime forward by the just-ended paused span and clears
	// the pause, so `now() - lastEventTime` continues to measure only active
	// time. Called by resumeSession and by any check-off that lands while
	// still paused (an implicit resume).
	private applyPauseOffset(session: ActiveSession) {
		if (session.pausedAt === null) return;
		const span = this.now() - session.pausedAt;
		session.lastEventTime += span;
		session.pausedMs += span;
		session.pausedAt = null;
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
		const currentState = block.items.map((item) => ({
			checked: item.checked,
			text: item.text,
		}));
		const previousState = this.blockStateCache.get(key);
		this.blockStateCache.set(key, currentState);

		// First time we've seen this block — don't fire on pre-existing checks
		// (no session resume by design, see CLAUDE.md).
		if (!previousState) return;

		// Check-off detection is positional: slot N is "newly checked" iff it
		// went false -> true since the previous parse. That only holds while the
		// list is stable. An item inserted, deleted, or renamed anywhere but the
		// tail shifts every slot below it, and the positional diff then misreads
		// the shift as a check-off — appending a phantom line to the output note
		// and resetting the in-progress item's clock. Detect that by comparing
		// item text at each shared slot: if any differs, the list moved under
		// us. Skip detection for this event (the cache is already re-baselined
		// above, so the next genuine check-off is measured cleanly against the
		// new shape). A pure tail add/remove leaves every shared slot aligned
		// and falls through to the normal diff untouched. Blind spot: a block
		// whose items all share the same text — an insertion there preserves the
		// prefix, so the shift isn't seen. Not worth handling (identical text is
		// already indistinguishable in the output).
		const shared = Math.min(previousState.length, currentState.length);
		let midListShift = false;
		for (let i = 0; i < shared; i++) {
			// i is in bounds for both; the `?.` is only to satisfy
			// noUncheckedIndexedAccess.
			if (previousState[i]?.text !== currentState[i]?.text) {
				midListShift = true;
				break;
			}
		}
		if (midListShift) {
			const session = this.activeSession;
			if (
				session &&
				session.filePath === file.path &&
				session.blockStartLine === block.startLine
			) {
				// Keep the status-bar's active-item view (getActiveTask) in step
				// with the edited list even though nothing was timed this event.
				// (A shift that deletes or moves the start item itself isn't fully
				// handled — see BACKLOG.md; recomputing startIndex here at least
				// keeps getActiveTask's pivot right for the common insert case.)
				session.items = block.items;
				session.startIndex = resolveStartIndex(block, this.settings.startTag);
				if (!this.blockShiftNotified.has(key)) {
					this.blockShiftNotified.add(key);
					this.notify(
						`Checklist timer: "${session.title}" — the checklist changed while timing; that edit wasn't recorded, timing continues.`,
						this.resultFileOptions(session),
					);
				}
			}
			return;
		}
		this.blockShiftNotified.delete(key);

		const newlyChecked: number[] = [];
		currentState.forEach((state, index) => {
			// previousState[index] is undefined for a brand-new tail slot — an
			// item that just appeared, not one that transitioned false -> true.
			// Without this guard a freshly appended `- [x]` line reads as a
			// check-off (and, at the last slot, finishes and resets the run).
			if (state.checked && previousState[index] && !previousState[index].checked) {
				newlyChecked.push(index);
			}
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
					// suppressAutoOpen: the user is mid-check-off on a *new*
					// checklist, not asking to see the old one's results — see
					// finishSession's doc comment on this parameter.
					await this.finishSession('stopped', undefined, undefined, { suppressAutoOpen: true });
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

		// A check-off while still paused is an implicit resume — fold the
		// paused span out first so it doesn't inflate this item's recorded time.
		this.applyPauseOffset(session);

		const duration = this.now() - session.lastEventTime;
		session.lastEventTime = this.now();
		session.results.push({ text: item.text, durationMs: duration });
		session.items = block.items;

		const wrote = await this.appendItem(session, item.text, duration);
		if (wrote) {
			this.notify(`⏱ ${formatDuration(duration)} - ${item.text}`, this.resultFileOptions(session));
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
		const startedAt = this.now();
		this.activeSession = {
			filePath: file.path,
			blockStartLine: block.startLine,
			startTime: startedAt,
			lastEventTime: startedAt,
			title,
			outputPath: this.resolveOutputPath(title),
			outputFile: null,
			results: [],
			items: block.items,
			startIndex,
			pausedAt: null,
			pausedMs: 0,
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
		const line = `- ${formatDuration(durationMs)} - ${text}\n`;
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
				// Static, written once into the note itself (rather than e.g. only
				// in a notice) so the hint is still there for anyone who opens the
				// note later on, not just right after the session ends.
				const barChartHint = this.settings.showReadingViewBarChart
					? '> [!tip] Switch to Reading view (📖 the book icon) to see each item as a bar chart.\n\n'
					: '';
				// end/total/longest are left empty here — they're not known until
				// the session finishes (finishSession fills them in via the same
				// writeNoteContent path as the footer). Pre-declaring them at
				// creation time, rather than adding them only at the end, means
				// Obsidian's Properties panel shows a consistent shape from the
				// note's first line onward, and a note left behind by a crash or
				// an abandoned run (see CLAUDE.md — no session-resume) reads
				// correctly as "incomplete" instead of missing the fields outright.
				const frontmatter = `---\nstart: ${formatTimestamp(session.startTime)}\nend: \ntotal: \nlongest: \n---\n\n`;
				const header = `${frontmatter}# ${session.title} timing\n\nSource: [[${this.sourceLinkTarget(session)}]]\n\n${barChartHint}${OUTPUT_NOTE_MARKER}\n\n`;
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
		// True only for the incidental stop inside handleItemChecked's
		// auto-switch branch: there, "finishing" the old session is a side
		// effect of the user starting a *new* checklist, not something they
		// asked to see — auto-opening the old session's note there would yank
		// them away from the checklist they just started checking off. A real
		// user-initiated stop (stopActiveSession) leaves this false, since
		// seeing the result *is* what they asked for.
		{ suppressAutoOpen = false }: { suppressAutoOpen?: boolean } = {},
	) {
		const session = this.activeSession;
		if (!session) return;
		this.activeSession = null;
		this.onStatusChange();

		const outputFile = session.outputFile;
		let totalMs = 0;
		let suffix = '';
		// Stringified inside the catch (matching resetChecklistBlock's pattern
		// below) rather than storing the raw `unknown` error — narrowing an
		// `unknown` variable with a later truthy check turns it into a bare
		// `{}` for the type checker, which no-base-to-string then flags as
		// unsafe to String().
		let footerErrorMessage: string | null = null;
		if (outputFile) {
			suffix = reason === 'stopped' ? ' (stopped early)' : '';
			totalMs = session.results.reduce((sum, result) => sum + result.durationMs, 0);
			const slowestFirst = [...session.results].sort((a, b) => b.durationMs - a.durationMs);
			const longestMs = slowestFirst[0]?.durationMs ?? 0;
			const slowestFirstLines = slowestFirst
				.map((result) => `- ${formatDuration(result.durationMs)} - ${result.text}`)
				.join('\n');
			// `## Slowest first` list + the `**Total:**` line — the bottleneck
			// view this plugin exists to surface. A `$` in an item's text is
			// safe here: it's only ever concatenated, never used as a
			// replacement string.
			const summaryBlock =
				`## Slowest first\n\n${slowestFirstLines}\n\n` +
				`**Total:** ${formatDuration(totalMs)}${suffix}`;
			try {
				await this.writeNoteContent(outputFile, (current) => {
					const withFrontmatter = current
						// `.*` (not an exact "key: " match) so this still finds the
						// placeholder line even if Obsidian has rewritten the
						// frontmatter in the meantime — e.g. the output note being
						// open in a pane's Properties panel (a real, documented case
						// here — see autoOpenOutputNote/EditorAccess) strips the
						// trailing space from an empty `end: ` down to `end:`. An
						// exact-match regex would silently no-op here, leaving the
						// note looking exactly like an *abandoned* one even though
						// the run completed normally.
						//
						// `end` uses lastEventTime (the last check-off), not
						// this.now() (the moment finishSession itself runs) — for a
						// natural completion the two are the same instant, but for a
						// manual stop there can be an arbitrary idle gap between the
						// last check-off and pressing stop. `pausedMs` is then
						// subtracted so paused spans don't inflate it either: every
						// item's recorded duration already excludes pause time, so
						// `total` does too, and `end` has to match. Together this
						// keeps `end - start` always equal to `total`, which is what
						// a Dataview query computing session length from these
						// properties would otherwise silently get wrong.
						.replace(
							/^end:.*$/m,
							`end: ${formatTimestamp(session.lastEventTime - session.pausedMs)}`,
						)
						.replace(/^total:.*$/m, `total: ${formatDuration(totalMs)}`)
						.replace(/^longest:.*$/m, `longest: ${formatDuration(longestMs)}`);
					// Normally the summary goes *above* the incrementally-built
					// "## In order" list (OUTPUT_NOTE_MARKER): that list can only
					// ever be chronological (items are written as they're checked
					// off), so leading with the slowest-first view is what the
					// reader sees on opening the note, without scrolling past the
					// raw run. But if the marker isn't in the body — a user
					// renamed the heading in an open pane, another plugin
					// restructured the note, a future change to the constant — a
					// plain `.replace` would no-op and silently drop the Total
					// line and the bottleneck view while the run still reports as
					// finished. Fall back to appending so the summary is always
					// written somewhere.
					return withFrontmatter.includes(OUTPUT_NOTE_MARKER)
						? withFrontmatter.replace(OUTPUT_NOTE_MARKER, () => `${summaryBlock}\n\n${OUTPUT_NOTE_MARKER}`)
						: `${withFrontmatter}\n${summaryBlock}\n`;
				});
			} catch (err) {
				footerErrorMessage = String(err);
			}
		}

		// Reset (when applicable) before the finish notice below, since that
		// notice may itself navigate a leaf (autoOpenOutputNote) — the reset
		// write needs the source note's live editor still discoverable via
		// EditorAccess.getOpenEditor, which a navigation away from it could
		// otherwise race. Only a natural finish (last item checked) resets
		// the checklist — a manual stop means the run was intentionally left
		// incomplete, so the checklist is left as-is rather than blanking out
		// real progress. Runs even when nothing was ever timed (e.g. the
		// start item is also the block's last item), since that's still a
		// completed run.
		if (reason === 'completed' && this.settings.resetOnCompletion && sourceFile && sourceBlock) {
			await this.resetChecklistBlock(sourceFile, sourceBlock);
		}

		if (!outputFile) {
			this.notify('Checklist timer: stopped (no items timed).');
		} else if (footerErrorMessage !== null) {
			this.notify(
				`Checklist timer: failed to write total to ${session.outputPath} (${footerErrorMessage})`,
				{ outputFile },
			);
		} else {
			this.notify(
				`✅ "${session.title}" finished in ${formatDuration(totalMs)}${suffix} — click to open results`,
				{
					outputFile,
					durationMs: FINISH_NOTICE_DURATION_MS,
					openInReadingView: this.settings.showReadingViewBarChart,
					autoOpen: !suppressAutoOpen && this.settings.autoOpenOutputNote,
				},
			);
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
		return session.outputFile ? { outputFile: session.outputFile } : undefined;
	}
}
