import { App, PluginSettingTab, Setting, SettingDefinitionItem } from 'obsidian';
import ChecklistTimerPlugin from './main';
import { ChecklistTimerSettings, DEFAULT_SETTINGS } from './settings-schema';
import { TimeFormat } from './utils/format';

export type { ChecklistTimerSettings };
export { DEFAULT_SETTINGS };

export class ChecklistTimerSettingTab extends PluginSettingTab {
	plugin: ChecklistTimerPlugin;

	constructor(app: App, plugin: ChecklistTimerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Declarative settings API (Obsidian 1.13.0+): makes these settings show
	// up in Obsidian's settings search. minAppVersion is below 1.13.0, so
	// display() below stays as the fallback renderer for older Obsidian —
	// this plugin supports both ("Path B" dual support) rather than raising
	// the floor just for this.
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Timed checklist tag',
				desc: 'A checklist is timed when the line right above it contains this tag.',
				control: {
					type: 'text',
					key: 'timedTag',
					placeholder: DEFAULT_SETTINGS.timedTag,
				},
			},
			{
				name: 'Start item tag',
				desc: "Within a timed checklist, the item whose text contains this tag starts the timer. If no item has it, the checklist's first item starts it instead.",
				control: {
					type: 'text',
					key: 'startTag',
					placeholder: DEFAULT_SETTINGS.startTag,
				},
			},
			{
				name: 'Auto-switch between checklists',
				desc: 'If you start a new timed checklist while another is still running, automatically stop the first (saving what it had timed so far) and start the new one. Turn this off to block the new checklist instead, leaving the first one running.',
				control: {
					type: 'toggle',
					key: 'autoSwitchSessions',
				},
			},
			{
				name: 'Output folder',
				desc: 'Vault-relative folder for timing notes. Leave empty for vault root.',
				control: {
					type: 'text',
					key: 'outputFolder',
					placeholder: '',
				},
			},
			{
				name: 'Filename template',
				desc: 'Supports {{date}} and {{title}} placeholders.',
				control: {
					type: 'text',
					key: 'filenameTemplate',
					placeholder: '{{date}} {{title}} timing',
				},
			},
			{
				name: 'Reset checklist when finished',
				desc: 'When a timed checklist is completed (its last item checked), automatically uncheck every item so it’s ready to run again next time — handy for recurring processes like a weekly review. Does not apply when a session is stopped early.',
				control: {
					type: 'toggle',
					key: 'resetOnCompletion',
				},
			},
			{
				name: 'Show active task timer',
				desc: 'Show the currently timed item and its elapsed time in the status bar.',
				control: {
					type: 'toggle',
					key: 'showActiveTaskTimer',
				},
			},
			{
				name: 'Active task timer format',
				desc: 'Time format for the status bar elapsed time.',
				control: {
					type: 'dropdown',
					key: 'activeTaskTimerFormat',
					options: {
						'mm:ss': 'mm:ss',
						'hh:mm': 'hh:mm',
						'hh:mm:ss': 'hh:mm:ss',
					},
				},
			},
			{
				name: 'Overwrite existing file',
				desc: 'If a file already exists at the output path — any file, not just one this plugin previously wrote — replace its contents entirely instead of showing an error. Off by default to avoid accidentally discarding an existing file.',
				control: {
					type: 'toggle',
					key: 'overwriteExistingFile',
				},
			},
		];
	}

	// The default PluginSettingTab#setControlValue writes the raw control
	// value straight to this.plugin.settings and doesn't know to trim input,
	// fall back to a default on empty, or notify SessionManager of the
	// change — all of which the imperative onChange handlers below do. Route
	// declarative-path writes through the same logic and through
	// plugin.saveSettings() so both paths behave identically.
	setControlValue(key: string, value: unknown): void | Promise<void> {
		switch (key) {
			case 'timedTag':
				this.plugin.settings.timedTag = (value as string).trim() || DEFAULT_SETTINGS.timedTag;
				break;
			case 'startTag':
				this.plugin.settings.startTag = (value as string).trim() || DEFAULT_SETTINGS.startTag;
				break;
			case 'autoSwitchSessions':
				this.plugin.settings.autoSwitchSessions = value as boolean;
				break;
			case 'outputFolder':
				this.plugin.settings.outputFolder = (value as string).trim();
				break;
			case 'filenameTemplate':
				this.plugin.settings.filenameTemplate =
					(value as string).trim() || DEFAULT_SETTINGS.filenameTemplate;
				break;
			case 'resetOnCompletion':
				this.plugin.settings.resetOnCompletion = value as boolean;
				break;
			case 'showActiveTaskTimer':
				this.plugin.settings.showActiveTaskTimer = value as boolean;
				break;
			case 'activeTaskTimerFormat':
				this.plugin.settings.activeTaskTimerFormat = value as TimeFormat;
				break;
			case 'overwriteExistingFile':
				this.plugin.settings.overwriteExistingFile = value as boolean;
				break;
		}
		return this.plugin.saveSettings();
	}

	// @deprecated Fallback renderer for Obsidian versions older than 1.13.0.
	// Bypassed automatically once the host app supports
	// getSettingDefinitions() above; see the comment on that method.
	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Timed checklist tag')
			.setDesc('A checklist is timed when the line right above it contains this tag.')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.timedTag)
					.setValue(this.plugin.settings.timedTag)
					.onChange(async (value) => {
						this.plugin.settings.timedTag = value.trim() || DEFAULT_SETTINGS.timedTag;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Start item tag')
			.setDesc(
				"Within a timed checklist, the item whose text contains this tag starts the timer. If no item has it, the checklist's first item starts it instead.",
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.startTag)
					.setValue(this.plugin.settings.startTag)
					.onChange(async (value) => {
						this.plugin.settings.startTag = value.trim() || DEFAULT_SETTINGS.startTag;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Auto-switch between checklists')
			.setDesc(
				'If you start a new timed checklist while another is still running, automatically stop the first (saving what it had timed so far) and start the new one. Turn this off to block the new checklist instead, leaving the first one running.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSwitchSessions)
					.onChange(async (value) => {
						this.plugin.settings.autoSwitchSessions = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Output folder')
			.setDesc('Vault-relative folder for timing notes. Leave empty for vault root.')
			.addText((text) =>
				text
					.setPlaceholder('')
					.setValue(this.plugin.settings.outputFolder)
					.onChange(async (value) => {
						this.plugin.settings.outputFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Filename template')
			.setDesc('Supports {{date}} and {{title}} placeholders.')
			.addText((text) =>
				text
					.setPlaceholder('{{date}} {{title}} timing')
					.setValue(this.plugin.settings.filenameTemplate)
					.onChange(async (value) => {
						this.plugin.settings.filenameTemplate =
							value.trim() || '{{date}} {{title}} timing';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Reset checklist when finished')
			.setDesc(
				'When a timed checklist is completed (its last item checked), automatically uncheck every item so it’s ready to run again next time — handy for recurring processes like a weekly review. Does not apply when a session is stopped early.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.resetOnCompletion)
					.onChange(async (value) => {
						this.plugin.settings.resetOnCompletion = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Show active task timer')
			.setDesc('Show the currently timed item and its elapsed time in the status bar.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showActiveTaskTimer)
					.onChange(async (value) => {
						this.plugin.settings.showActiveTaskTimer = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Active task timer format')
			.setDesc('Time format for the status bar elapsed time.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('mm:ss', 'mm:ss')
					.addOption('hh:mm', 'hh:mm')
					.addOption('hh:mm:ss', 'hh:mm:ss')
					.setValue(this.plugin.settings.activeTaskTimerFormat)
					.onChange(async (value) => {
						this.plugin.settings.activeTaskTimerFormat = value as TimeFormat;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Overwrite existing file')
			.setDesc(
				'If a file already exists at the output path — any file, not just one this plugin previously wrote — replace its contents entirely instead of showing an error. Off by default to avoid accidentally discarding an existing file.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.overwriteExistingFile)
					.onChange(async (value) => {
						this.plugin.settings.overwriteExistingFile = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
