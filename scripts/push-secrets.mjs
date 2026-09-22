#!/usr/bin/env node
/**
 * Push SUPABASE_URL and SUPABASE_SERVICE_KEY from .dev.vars into Worker secrets.
 *
 * `wrangler secret put` reads the value from stdin, so this exists mainly to do
 * both in one command after a deploy — a deployment that loses its secrets still
 * serves 200s and looks healthy, so it is worth making trivial to redo.
 *
 *   npm run secrets:push [-- --temporary]
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extra = process.argv.slice(2);

const vars = new Map();
for (const line of readFileSync(join(root, '.dev.vars'), 'utf8').split('\n')) {
	const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
	if (m) vars.set(m[1], m[2]);
}

for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']) {
	const value = vars.get(name);
	if (!value) {
		console.error(`✗ ${name} is not in .dev.vars`);
		process.exit(1);
	}
	await new Promise((resolve, reject) => {
		const p = spawn('npx', ['wrangler', 'secret', 'put', name, ...extra], { cwd: root, shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
		p.stdin.end(value);
		p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${name}: wrangler exited ${code}`))));
	});
}
