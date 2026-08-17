// Plain data shape for settings, kept free of any Obsidian runtime import so
// it (and anything that only needs it, like SessionManager) can be unit
// tested without a real Obsidian environment. The UI (ChecklistTimerSettingTab
// in settings.ts) does need real Obsidian classes and is not unit tested.
export interface ChecklistTimerSettings {
	// A checklist is timed when the line immediately above it contains this
	// tag (same convention as the Checklist plugin). See CLAUDE.md.
	timedTag: string;
	// Within a timed checklist, whichever item's text contains this tag is
	// the start item. If no item has it, the first item is the start item.
	startTag: string;
	// Only one session can run at a time (see CLAUDE.md). When true, starting
	// a second timed checklist while one is running automatically stops the
	// first (saving whatever it had timed) and starts the new one. When
	// false, the second checklist is blocked instead — its check-offs are
	// not tracked until the first session ends.
	autoSwitchSessions: boolean;
	// Vault-relative folder for timing output notes. Empty = vault root.
	outputFolder: string;
	// Supports {{date}} and {{title}} placeholders.
	filenameTemplate: string;
}

export const DEFAULT_SETTINGS: ChecklistTimerSettings = {
	timedTag: '#timed',
	startTag: '#start',
	autoSwitchSessions: true,
	outputFolder: '',
	filenameTemplate: '{{date}} {{title}} timing',
};
