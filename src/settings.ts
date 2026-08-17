import { App, PluginSettingTab, Setting } from 'obsidian';
import ChecklistTimerPlugin from './main';
import { ChecklistTimerSettings, DEFAULT_SETTINGS } from './settings-schema';

export type { ChecklistTimerSettings };
export { DEFAULT_SETTINGS };

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
			.setDesc('A checklist is timed when the line right above it contains this tag.')
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
			.setName('Start item tag')
			.setDesc(
				"Within a timed checklist, the item whose text contains this tag starts the timer. If no item has it, the checklist's first item starts it instead.",
			)
			.addText((text) =>
				text
					.setPlaceholder('#start')
					.setValue(this.plugin.settings.startTag)
					.onChange(async (value) => {
						this.plugin.settings.startTag = value.trim() || '#start';
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
	}
}
