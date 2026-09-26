import {
	MarkdownFileInfo,
	MarkdownView,
	Notice,
	normalizePath,
	Plugin,
	TFile,
} from 'obsidian';
import {
	DEFAULT_SETTINGS,
	ChecklistTimerSettings,
	ChecklistTimerSettingTab,
} from './settings';
import { SessionManager } from './session-manager';
import { EditorAccess, OpenEditor, VaultAccess } from './timer-port';
import { formatElapsed, truncateTaskName } from './utils/format';
import { computeBarFractions, OUTPUT_NOTE_MARKER, parseDurationMs } from './utils/duration-bars';

// Status bar tick cadence. formatElapsed only changes visibly every minute
// for the 'hh:mm' format, but ticking every second regardless is simpler
// than reconfiguring the interval whenever the format setting changes, and
// costs nothing noticeable per tick — the interval itself is only alive
// while there's actually something to tick (see start/stopActiveTaskTicker).
const ACTIVE_TASK_TICK_MS = 1_000;

export default class ChecklistTimerPlugin extends Plugin {
	settings!: ChecklistTimerSettings;
	sessionManager!: SessionManager;
	private statusBarItemEl!: HTMLElement;
	// Not registerInterval()'d — its lifetime is shorter than the plugin's
	// (started only while the status bar item is actually showing), so it's
	// started/stopped by hand and swept up in onunload() instead.
	private activeTaskIntervalId: number | null = null;

	async onload() {
		await this.loadSettings();

		// Display-only (never registers a click handler) — the active task
		// timer, shown only while enabled in settings and a session is running.
		this.statusBarItemEl = this.addStatusBarItem();
		this.statusBarItemEl.addClass('checklist-timer-active-task');
		this.statusBarItemEl.hide();

		this.sessionManager = new SessionManager(
			this.vaultAccess(),
			this.settings,
			() => this.updateActiveTaskStatusBar(),
			(message, options) => {
				const notice = new Notice(message, options?.durationMs);
				const file = options?.outputFile;
				if (!file) return;
				// noticeEl (not the 1.8.7+ messageEl) so click-to-open still works
				// down to this plugin's minAppVersion.
				notice.noticeEl.addClass('checklist-timer-clickable-notice');
				// Guards against opening the note twice — once via autoOpen below,
				// once more if the user then clicks the same notice (it stays
				// clickable for its full visible duration) — which would otherwise
				// re-run getLeaf(false).openFile() on a file already open there.
				let opened = false;
				const open = () => {
					if (opened) return;
					opened = true;
					this.openOutputFile(file, options?.openInReadingView);
				};
				notice.noticeEl.addEventListener('click', open);
				// autoOpen is already resolved against autoOpenOutputNote (and
				// against the auto-switch edge case) in session-manager.ts — see
				// the NotifyOptions doc comment — so it's read as-is here rather
				// than re-checked against settings.
				if (options?.autoOpen) open();
			},
			Date.now,
			normalizePath,
			this.editorAccess(),
		);

		this.addRibbonIcon('timer', 'Stop checklist timer', () => {
			void this.sessionManager.stopActiveSession();
		});

		this.addCommand({
			id: 'stop-active-timer',
			name: 'Stop active timer',
			callback: () => {
				void this.sessionManager.stopActiveSession();
			},
		});

		this.addCommand({
			id: 'pause-active-timer',
			name: 'Pause active timer',
			callback: () => {
				this.sessionManager.pauseSession();
			},
		});

		this.addCommand({
			id: 'resume-active-timer',
			name: 'Resume active timer',
			callback: () => {
				this.sessionManager.resumeSession();
			},
		});

		this.addSettingTab(new ChecklistTimerSettingTab(this.app, this));

		// Reading view only (see CLAUDE.md/the bar chart brief) — this
		// post-processor runs on Reading view's rendered HTML, a separate path
		// from Live Preview/Source mode's CodeMirror editor, which this plugin
		// deliberately does not touch for this feature (an earlier attempt at
		// injecting into Live Preview crashed the plugin with internal
		// CodeMirror errors).
		this.registerMarkdownPostProcessor((el, ctx) => {
			if (!this.settings.showReadingViewBarChart) return;
			// Scopes rendering to this plugin's own output notes — without this,
			// any rendered list item elsewhere that happens to read
			// "HH:MM:SS - text" (e.g. a personal log entry) would get a fake bar
			// too. getSectionInfo's `text` is the whole document's raw source
			// (not just this element's section), so these checks are accurate
			// regardless of which part of the note this particular call covers.
			// A null sectionInfo (which the Obsidian API says can happen) fails
			// closed — no bar — rather than risk a false positive elsewhere.
			const sectionInfo = ctx.getSectionInfo(el);
			if (!sectionInfo) return;
			// Two independent signals, both required. The "## In order" heading
			// alone (OUTPUT_NOTE_MARKER) is a generic string a workout log or a
			// cooking-times note could plausibly carry alongside HH:MM:SS list
			// items — an acceptable false-positive risk while this was opt-in,
			// but not now that it renders for everyone by default. The plugin's
			// own output notes also always carry a `longest:` frontmatter key,
			// written the moment the note is created (blank until the session
			// finishes — see session-manager.ts), which a stray note won't have.
			if (!sectionInfo.text.includes(OUTPUT_NOTE_MARKER)) return;
			if (!/^longest:/m.test(sectionInfo.text)) return;
			this.renderDurationBars(el);
		});

		this.registerEvent(
			this.app.workspace.on('editor-change', (editor, info) => {
				const file = this.resolveFile(info);
				if (!file) return;
				void this.sessionManager.handleFileContent(file, editor.getValue());
			}),
		);

		// Catches check-offs that never pass through a live editor — e.g. the
		// Checklist plugin's sidebar view, or Reading View, both of which write
		// to the file directly via the Vault API. editor-change alone missed
		// these, and previously only "worked" by accident when the note also
		// happened to be open in an editor that received the synced change.
		// SessionManager's block-state cache diffs against previous state, so
		// a change already seen via editor-change is a harmless no-op here.
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				void this.app.vault.cachedRead(file).then((content) => {
					void this.sessionManager.handleFileContent(file, content);
				});
			}),
		);

		// Seeds SessionManager's block-state cache the moment a note becomes
		// active, before the user has any chance to click a checkbox — closes a
		// race where opening a note and immediately checking its start item (with
		// no other edit having touched the note since Obsidian/the plugin last
		// loaded) is itself the block's first observation, so that genuine
		// check-off reads as pre-existing state and is silently swallowed. See
		// SessionManager.primeFile's doc comment.
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (!file || file.extension !== 'md') return;
				void this.app.vault.cachedRead(file).then((content) => {
					this.sessionManager.primeFile(file, content);
				});
			}),
		);

		// file-open only fires on a change of active file, so it misses notes
		// already sitting open in a pane when the plugin loads (app startup with
		// restored tabs, or a plugin reload in the dev vault) — prime those too,
		// from each editor's live buffer rather than disk, since the buffer may
		// be ahead of a not-yet-saved disk copy.
		this.app.workspace.onLayoutReady(() => {
			this.app.workspace.iterateAllLeaves((leaf) => {
				const view = leaf.view;
				if (view instanceof MarkdownView && view.file) {
					this.sessionManager.primeFile(view.file, view.editor.getValue());
				}
			});

			// file-open only covers notes that become the active pane. A
			// check-off can also arrive with the source note never opened at
			// all — the Checklist plugin's sidebar, an embedded (![[...]])
			// checklist, or a hover preview all write straight to the note.
			// Prime every note that carries the timed tag, found via
			// metadataCache (already computed, no extra parsing) rather than
			// reading the whole vault — primeFile no-ops on a block it's
			// already seen, so this can't clobber the live-buffer prime above.
			void this.primeAllTimedNotes();
		});

		// Covers a note created fresh from a template with the tag already in
		// it (e.g. a new week's plan) and then checked off via the sidebar/an
		// embed before ever being opened as its own pane — the layout-ready
		// scan above only sees notes that existed at load time.
		this.registerEvent(
			this.app.vault.on('create', (file) => {
				// Obsidian also fires 'create' once per file during the initial
				// vault scan on load — those are already covered by
				// primeAllTimedNotes() above, so skip until the workspace (and
				// that scan) is done to avoid redundant reads at startup.
				if (!this.app.workspace.layoutReady) return;
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				if (!this.fileHasTimedTag(file)) return;
				void this.app.vault.cachedRead(file).then((content) => {
					this.sessionManager.primeFile(file, content);
				});
			}),
		);
	}

	private fileHasTimedTag(file: TFile): boolean {
		const cache = this.app.metadataCache.getFileCache(file);
		// A brand-new file's metadata is resolved asynchronously after
		// vault.on('create') fires, so the cache is typically still null at
		// that point — treat "not yet indexed" as "can't rule it out" rather
		// than silently skipping it. primeFile itself filters through
		// findTimedBlocks, so an untagged file costs one harmless cachedRead.
		if (!cache) return true;
		const needle = this.settings.timedTag.toLowerCase();
		return (cache.tags ?? []).some((t) => t.tag.toLowerCase().includes(needle));
	}

	private async primeAllTimedNotes() {
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!this.fileHasTimedTag(file)) continue;
			const content = await this.app.vault.cachedRead(file);
			this.sessionManager.primeFile(file, content);
		}
	}

	onunload() {
		this.stopActiveTaskTicker();
	}

	private resolveFile(info: MarkdownView | MarkdownFileInfo): TFile | null {
		return info.file ?? null;
	}

	// Finds rendered list items that look like an output note's timed-item
	// lines (see utils/duration-bars.ts) and gives each one a small bar sized
	// relative to the slowest duration among the items in this same call. A
	// single list (e.g. the "In order" list, or the "Slowest first" list) is
	// always rendered as one call rather than split across several, so
	// computing the max within just this call's items is enough — no need to
	// read the rest of the note to find the true document-wide max, since
	// every list in this note format contains the same full set of items.
	private renderDurationBars(el: HTMLElement) {
		const candidates = Array.from(el.querySelectorAll('li'))
			.map((li) => ({ li, durationMs: parseDurationMs(li.textContent?.trim() ?? '') }))
			.filter((entry): entry is { li: HTMLLIElement; durationMs: number } => entry.durationMs !== null);
		if (candidates.length === 0) return;

		const fractions = computeBarFractions(candidates.map((entry) => entry.durationMs));
		candidates.forEach(({ li }, index) => {
			// The post-processor contract doesn't guarantee every call gets a
			// fresh element (e.g. a re-render pass while the note, written
			// incrementally, is open in Reading view) — skip rather than stack a
			// second bar under an item that already has one.
			if (li.querySelector('.checklist-timer-bar-track')) return;
			const track = li.createDiv({ cls: 'checklist-timer-bar-track' });
			const fill = track.createDiv({ cls: 'checklist-timer-bar-fill' });
			fill.style.width = `${Math.round((fractions[index] ?? 0) * 100)}%`;
		});
	}

	// Shared by the finish notice's click handler and its autoOpenOutputNote
	// auto-open — openInReadingView is only ever set on the finish notice
	// (see NotifyOptions), so both paths land in the same place either way.
	// Takes the TFile directly (NotifyOptions.outputFile) rather than a path
	// to resolve — SessionManager already holds the live TFile it just wrote
	// to, so there's no separate lookup here to race a rename/delete.
	private openOutputFile(file: TFile, openInReadingView?: boolean) {
		const openState = openInReadingView ? { state: { mode: 'preview' } } : undefined;
		void this.app.workspace.getLeaf(false).openFile(file, openState);
	}

	// Wraps the real Vault so SessionManager gets a proper TFile-or-null from
	// getExistingFile — real Obsidian's getAbstractFileByPath can return a
	// TFolder, and `instanceof TFile` (only usable here, where the real
	// Obsidian module is actually loaded — see the VaultAccess doc comment in
	// timer-port.ts) is what tells the two apart.
	private vaultAccess(): VaultAccess {
		const vault = this.app.vault;
		return {
			getAbstractFileByPath: (path) => vault.getAbstractFileByPath(path),
			getExistingFile: (path) => {
				const file = vault.getAbstractFileByPath(path);
				return file instanceof TFile ? file : null;
			},
			createFolder: (path) => vault.createFolder(path),
			create: (path, content) => vault.create(path, content),
			read: (file) => vault.read(file),
			modify: (file, content) => vault.modify(file, content),
		};
	}

	// Finds a live editor for `path` across every open pane (not just the
	// active one), so SessionManager can write through it instead of
	// straight to disk — see the EditorAccess doc comment in timer-port.ts.
	private editorAccess(): EditorAccess {
		return {
			getOpenEditor: (path: string): OpenEditor | null => {
				let found: OpenEditor | null = null;
				this.app.workspace.iterateAllLeaves((leaf) => {
					if (found) return;
					const view = leaf.view;
					if (view instanceof MarkdownView && view.file?.path === path) {
						found = view.editor;
					}
				});
				return found;
			},
		};
	}

	// Hidden whenever the setting is off or nothing is running (acceptance
	// criteria: no task running, or the feature disabled, means no status bar
	// item at all — not just an empty one). Mirrors the compact "⏱ item: time"
	// shape of the per-item notices (see SessionManager) instead of spelling
	// out "Checklist timer: running" — one glance, not a sentence.
	private updateActiveTaskStatusBar() {
		if (!this.settings.showActiveTaskTimer) {
			this.statusBarItemEl.hide();
			this.stopActiveTaskTicker();
			return;
		}
		const task = this.sessionManager.getActiveTask();
		if (!task) {
			this.statusBarItemEl.hide();
			this.stopActiveTaskTicker();
			return;
		}
		// While paused, freeze the elapsed time at the pause instant and swap
		// the icon — otherwise the status bar would keep ticking up even
		// though no item is accumulating time.
		const reference = task.pausedAt ?? Date.now();
		const elapsed = formatElapsed(reference - task.startTime, this.settings.activeTaskTimerFormat);
		const icon = task.pausedAt !== null ? '⏸' : '⏱';
		this.statusBarItemEl.setText(`${icon} ${truncateTaskName(task.name)}: ${elapsed}`);
		this.statusBarItemEl.show();
		if (task.pausedAt !== null) {
			// The readout is frozen — no reason to keep waking once a second
			// through what could be a long break. resumeSession fires
			// onStatusChange again, which lands back here and restarts it.
			this.stopActiveTaskTicker();
		} else {
			this.startActiveTaskTicker();
		}
	}

	// Only ticks while the status bar item actually has something to show —
	// cheap per-tick, but no reason to run once a second for the plugin's
	// entire lifetime when most of that time nothing is being timed.
	private startActiveTaskTicker() {
		if (this.activeTaskIntervalId !== null) return;
		this.activeTaskIntervalId = window.setInterval(
			() => this.updateActiveTaskStatusBar(),
			ACTIVE_TASK_TICK_MS,
		);
	}

	private stopActiveTaskTicker() {
		if (this.activeTaskIntervalId === null) return;
		window.clearInterval(this.activeTaskIntervalId);
		this.activeTaskIntervalId = null;
	}

	async loadSettings() {
		// Note the flip of showReadingViewBarChart to default-on only reaches
		// fresh installs and users who never triggered a saveSettings() write —
		// anyone with the old `false` persisted in data.json keeps it, by
		// design. No migration: a write-on-load force-flip can't tell a
		// deliberate opt-out from a `false` persisted as a side-effect of
		// saving some unrelated setting, and that machinery isn't worth it for
		// a cosmetic default. Existing users (the author included) enable it
		// once per vault; called out in the release notes.
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<ChecklistTimerSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.sessionManager.updateSettings(this.settings);
		this.updateActiveTaskStatusBar();
	}
}
