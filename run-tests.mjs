import { readdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

// Node's `--test` glob support for CLI file arguments isn't consistent across
// the Node versions in CI (20.x doesn't support it the way 22.x/24.x do), so
// discover test files ourselves and pass them as explicit arguments instead.
function findTestFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...findTestFiles(path));
		} else if (entry.name.endsWith('.test.ts')) {
			files.push(path);
		}
	}
	return files;
}

const testFiles = findTestFiles('src');
const result = spawnSync('node', ['--import', 'tsx', '--test', ...testFiles], {
	stdio: 'inherit',
});
process.exit(result.status ?? 1);
