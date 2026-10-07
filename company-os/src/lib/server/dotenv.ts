/**
 * Minimal .env loader — dev parity for anything that runs outside vite
 * (the CLI paths). Read-ONLY: values land in `process.env` for this process;
 * the .env file itself is never written. Real environment always wins.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadDotEnv(env: NodeJS.ProcessEnv = process.env, dir = process.cwd()): void {
	const file = join(dir, '.env');
	if (!existsSync(file)) return;
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
		if (match && env[match[1]!] === undefined) {
			env[match[1]!] = match[2]!.replace(/^["']|["']$/g, '');
		}
	}
}
