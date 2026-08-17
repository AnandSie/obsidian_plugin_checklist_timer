import { MarkdownFileInfo, MarkdownView, Plugin, TFile } from 'obsidian';
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

		this.sessionManager = new SessionManager(this.app, this.settings, (status) =>
			this.statusBarItemEl.setText(status),
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
