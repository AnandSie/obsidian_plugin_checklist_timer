import type { TFile } from 'obsidian';

// The narrow slice of Obsidian's Vault API that SessionManager needs. Lets
// tests supply an in-memory fake instead of a real Obsidian App/Vault — the
// `obsidian` npm package is types-only and has no runtime implementation.
export interface VaultAccess {
	getAbstractFileByPath(path: string): unknown;
	createFolder(path: string): Promise<unknown>;
	create(path: string, content: string): Promise<TFile>;
	read(file: TFile): Promise<string>;
	modify(file: TFile, content: string): Promise<void>;
}

// The narrow slice of Obsidian's Workspace that SessionManager needs to write
// safely into a note that might already be open in a live editor. When a
// pane has the target note open, writing through *that* editor keeps it as
// the single source of truth; writing straight to disk instead (vault.modify)
// risks the editor's own — possibly stale — buffer being saved back
// afterwards and silently clobbering the write. See CLAUDE.md "Known
// issues" for the concrete failure mode this exists to avoid.
export interface EditorAccess {
	// Returns a handle for the editor currently displaying `path` in some
	// pane, or null if the note isn't open anywhere.
	getOpenEditor(path: string): OpenEditor | null;
}

// Matches the subset of Obsidian's real `Editor` that writeNoteContent
// needs — Obsidian's Editor already satisfies this structurally.
export interface OpenEditor {
	getValue(): string;
	setValue(value: string): void;
}

export interface NotifyOptions {
	// Vault-relative path to open (in the active leaf) if the user clicks the
	// notice — used for the finish notice so it doubles as a shortcut to the
	// result note.
	filePath?: string;
	// Overrides Obsidian's default auto-dismiss timeout (ms) for this notice.
	durationMs?: number;
}

export type Notifier = (message: string, options?: NotifyOptions) => void;
