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
				const filePath = options?.filePath;
				if (!filePath) return;
				// noticeEl (not the 1.8.7+ messageEl) so click-to-open still works
				// down to this plugin's minAppVersion.
				notice.noticeEl.addClass('checklist-timer-clickable-notice');
				notice.noticeEl.addEventListener('click', () => {
					const file = this.app.vault.getAbstractFileByPath(filePath);
					if (file instanceof TFile) {
						// Only the finish notice sets openInReadingView (see its doc
						// comment in timer-port.ts) — other clickable notices during a
						// still-running session (e.g. per-item "⏱ ..." notices) leave
						// this unset, so clicking them respects the leaf's normal
						// default mode instead of yanking an in-progress note into
						// Reading view.
						const openState = options?.openInReadingView ? { state: { mode: 'preview' } } : undefined;
						void this.app.workspace.getLeaf(false).openFile(file, openState);
					}
				});
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
			// (not just this element's section), so this check is accurate
			// regardless of which part of the note this particular call covers.
			// A null sectionInfo (which the Obsidian API says can happen) fails
			// closed — no bar — rather than risk a false positive elsewhere.
			const sectionInfo = ctx.getSectionInfo(el);
			if (!sectionInfo?.text.includes(OUTPUT_NOTE_MARKER)) return;
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
		const elapsed = formatElapsed(Date.now() - task.startTime, this.settings.activeTaskTimerFormat);
		this.statusBarItemEl.setText(`⏱ ${truncateTaskName(task.name)}: ${elapsed}`);
		this.statusBarItemEl.show();
		this.startActiveTaskTicker();
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
