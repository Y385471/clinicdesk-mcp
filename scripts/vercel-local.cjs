// Run the Vercel function locally on plain node:http — no vercel login, no new
// dependencies. `npm run dev:vercel` compiles api/mcp.ts to .vercel-local/ and
// serves it here, so the stateless transport can be smoke-tested before deploy:
//
//   npm run dev:vercel
//   npm run smoke -- http://localhost:8799/api/mcp
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(root, '.dev.vars'), 'utf8').split('\n')) {
	const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
	if (m) process.env[m[1]] = m[2];
}

const mod = require(path.join(root, '.vercel-local/api/mcp.js'));
// Same dispatch Vercel does: the export named after the HTTP method.
const pick = (method) => mod[method] || mod.default;
const port = Number(process.env.PORT ?? 8799);

http
	.createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const request = new Request(`http://localhost:${port}${req.url}`, {
			method: req.method,
			headers: req.headers,
			body: chunks.length ? Buffer.concat(chunks) : undefined,
		});
		const fn = pick(req.method);
		if (!fn) { res.writeHead(405).end(); return; }
		const out = await fn(request);
		res.writeHead(out.status, Object.fromEntries(out.headers));
		res.end(Buffer.from(await out.arrayBuffer()));
	})
	.listen(port, () => console.log(`Vercel function on http://localhost:${port}/api/mcp`));
