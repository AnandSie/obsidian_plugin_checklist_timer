import type { TFile } from 'obsidian';

// The narrow slice of Obsidian's Vault API that SessionManager needs. Lets
// tests supply an in-memory fake instead of a real Obsidian App/Vault — the
// `obsidian` npm package is types-only and has no runtime implementation.
export interface VaultAccess {
	getAbstractFileByPath(path: string): unknown;
	createFolder(path: string): Promise<unknown>;
	create(path: string, content: string): Promise<TFile>;
	append(file: TFile, content: string): Promise<void>;
	modify(file: TFile, content: string): Promise<void>;
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
