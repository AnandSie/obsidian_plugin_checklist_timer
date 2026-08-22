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

export default class ChecklistTimerPlugin extends Plugin {
	settings!: ChecklistTimerSettings;
	sessionManager!: SessionManager;
	private statusBarItemEl!: HTMLElement;

	async onload() {
		await this.loadSettings();

		this.statusBarItemEl = this.addStatusBarItem();

		this.sessionManager = new SessionManager(
			this.app.vault,
			this.settings,
			(status) => this.statusBarItemEl.setText(status),
			(message) => new Notice(message),
			Date.now,
			normalizePath,
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
	}
}
