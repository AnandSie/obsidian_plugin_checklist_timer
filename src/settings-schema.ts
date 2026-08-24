import { TimeFormat } from './utils/format';

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
	// When true (default), a session that finishes naturally (its last item
	// gets checked) also unchecks every item in the checklist, so a recurring
	// process (e.g. a weekly review template) is ready to run again next time
	// without manual cleanup. Does not apply to a manual stop — an
	// intentionally incomplete run leaves the checklist as-is.
	resetOnCompletion: boolean;
	// Show the currently timed item and its elapsed time in the status bar.
	// Default on — it's the plugin's main "yes, it's working" signal.
	showActiveTaskTimer: boolean;
	// Time format for the status bar elapsed time (see utils/format.ts).
	activeTaskTimerFormat: TimeFormat;
	// When true, whatever file already exists at the resolved output path —
	// not necessarily one this plugin wrote — is fully replaced (old content
	// discarded) instead of erroring. outputFolder/filenameTemplate are both
	// user-configurable, so this can collide with an unrelated, manually
	// authored note of the same name. Default off — silently discarding a
	// file's contents is a data-loss risk, so it's an opt-in convenience
	// rather than the default.
	overwriteExistingFile: boolean;
	// When true, each timed item gets a small rendered bar next to it, sized
	// relative to the slowest item, when the output note is viewed in
	// Reading view. Computed at render time (not write time), so it applies
	// to both the "In order" and "Slowest first" lists. Reading view only;
	// Live Preview/Source mode are a separate rendering path and are
	// intentionally not touched. Default off, like the plugin's other
	// settings that change what gets shown.
	showReadingViewBarChart: boolean;
	// When true (default), the output note is opened automatically the
	// moment a session finishes (completed or stopped early) — the same note
	// the finish notice already links to, just without needing the click.
	autoOpenOutputNote: boolean;
}

export const DEFAULT_SETTINGS: ChecklistTimerSettings = {
	timedTag: '#Timed',
	startTag: '#Start',
	autoSwitchSessions: true,
	outputFolder: '',
	filenameTemplate: '{{date}} {{title}} timing',
	resetOnCompletion: true,
	showActiveTaskTimer: true,
	activeTaskTimerFormat: 'mm:ss',
	overwriteExistingFile: false,
	showReadingViewBarChart: false,
	autoOpenOutputNote: true,
};
