import type { TFile } from 'obsidian';

// The narrow slice of Obsidian's Vault API that SessionManager needs. Lets
// tests supply an in-memory fake instead of a real Obsidian App/Vault — the
// `obsidian` npm package is types-only and has no runtime implementation.
export interface VaultAccess {
	getAbstractFileByPath(path: string): unknown;
	createFolder(path: string): Promise<unknown>;
	create(path: string, content: string): Promise<TFile>;
	append(file: TFile, content: string): Promise<void>;
}

export type Notifier = (message: string) => void;
