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
import { EditorAccess, OpenEditor } from './timer-port';
import { formatElapsed, truncateTaskName } from './utils/format';

// Status bar tick cadence. formatElapsed only changes visibly every minute
// for the 'hh:mm' format, but ticking every second regardless is simpler
// than reconfiguring the interval whenever the format setting changes, and
// costs nothing noticeable.
const ACTIVE_TASK_TICK_MS = 1_000;

export default class ChecklistTimerPlugin extends Plugin {
	settings!: ChecklistTimerSettings;
	sessionManager!: SessionManager;
	private statusBarItemEl!: HTMLElement;

	async onload() {
		await this.loadSettings();

		// Display-only (never registers a click handler) — the active task
		// timer, shown only while enabled in settings and a session is running.
		this.statusBarItemEl = this.addStatusBarItem();
		this.statusBarItemEl.addClass('checklist-timer-active-task');
		this.statusBarItemEl.hide();

		this.sessionManager = new SessionManager(
			this.app.vault,
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
						void this.app.workspace.getLeaf(false).openFile(file);
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

		this.registerInterval(
			window.setInterval(() => this.updateActiveTaskStatusBar(), ACTIVE_TASK_TICK_MS),
		);

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

	onunload() {}

	private resolveFile(info: MarkdownView | MarkdownFileInfo): TFile | null {
		return info.file ?? null;
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
			return;
		}
		const task = this.sessionManager.getActiveTask();
		if (!task) {
			this.statusBarItemEl.hide();
			return;
		}
		const elapsed = formatElapsed(Date.now() - task.startTime, this.settings.activeTaskTimerFormat);
		this.statusBarItemEl.setText(`⏱ ${truncateTaskName(task.name)}: ${elapsed}`);
		this.statusBarItemEl.show();
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
