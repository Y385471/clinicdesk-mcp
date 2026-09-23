// Serves the demo studio locally and saves the finished recording to disk.
// node demo/server.mjs  →  http://localhost:8791/studio.html
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.wav': 'audio/wav', '.js': 'text/javascript', '.png': 'image/png' };

createServer(async (req, res) => {
	try {
		if (req.method === 'POST' && (req.url === '/save' || req.url === '/save-mp4')) {
			const chunks = [];
			for await (const c of req) chunks.push(c);
			const buf = Buffer.concat(chunks);
			const name = req.url === '/save' ? 'clinicdesk-demo.webm' : 'clinicdesk-demo.mp4';
			await writeFile(join(root, name), buf);
			res.writeHead(200).end(`saved ${buf.length} bytes`);
			console.log(`saved ${name} (${buf.length} bytes)`);
			return;
		}
		const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
		const file = join(root, path || 'studio.html');
		if (!file.startsWith(root)) return res.writeHead(403).end();
		const body = await readFile(file);
		res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
	} catch {
		res.writeHead(404).end('not found');
	}
}).listen(8791, () => console.log('studio on http://localhost:8791/studio.html'));
