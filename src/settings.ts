import { App, PluginSettingTab, Setting } from 'obsidian';
import ChecklistTimerPlugin from './main';

export interface ChecklistTimerSettings {
	mySetting: string;
}

export const DEFAULT_SETTINGS: ChecklistTimerSettings = {
	mySetting: 'default',
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
			.setName('Settings #1')
			.setDesc("It's a secret")
			.addText((text) =>
				text
					.setPlaceholder('Enter your secret')
					.setValue(this.plugin.settings.mySetting)
					.onChange(async (value) => {
						this.plugin.settings.mySetting = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
