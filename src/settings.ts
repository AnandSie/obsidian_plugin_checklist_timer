import { App, PluginSettingTab, Setting } from 'obsidian';
import ChecklistTimerPlugin from './main';

export interface ChecklistTimerSettings {
	// A checklist is timed when the line immediately above it contains this
	// tag (same convention as the Checklist plugin). The list's first item
	// is the start item. See CLAUDE.md.
	timedTag: string;
	// Vault-relative folder for timing output notes. Empty = vault root.
	outputFolder: string;
	// Supports {{date}} and {{title}} placeholders.
	filenameTemplate: string;
}

export const DEFAULT_SETTINGS: ChecklistTimerSettings = {
	timedTag: '#timed',
	outputFolder: '',
	filenameTemplate: '{{date}} {{title}} timing',
};

export class ChecklistTimerSettingTab extends PluginSettingTab {
	plugin: ChecklistTimerPlugin;

	constructor(app: App, plugin: ChecklistTimerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Timed checklist tag')
			.setDesc(
				'A checklist is timed when the line right above it contains this tag. Checking the first item then starts the timer.',
			)
			.addText((text) =>
				text
					.setPlaceholder('#timed')
					.setValue(this.plugin.settings.timedTag)
					.onChange(async (value) => {
						this.plugin.settings.timedTag = value.trim() || '#timed';
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
	}
}
