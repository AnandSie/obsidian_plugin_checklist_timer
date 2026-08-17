export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad = (n: number) => n.toString().padStart(2, '0');
	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function renderFilename(template: string, title: string): string {
	const date = new Date().toISOString().slice(0, 10);
	return template.replace(/\{\{date\}\}/g, date).replace(/\{\{title\}\}/g, title);
}
