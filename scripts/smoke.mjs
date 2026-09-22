#!/usr/bin/env node
/**
 * End-to-end check against a deployed server — the real handshake, not a ping.
 *
 * Written after a deploy silently dropped the Worker secrets: every tool still
 * answered 200 and the landing page still loaded, but each call came back as an
 * error inside the result. A health endpoint cannot catch that. This does a full
 * initialize → tools/list → tools/call and asserts the triage answers.
 *
 *   npm run smoke                       # localhost:8787
 *   npm run smoke -- https://host/mcp   # a deployment
 */

const endpoint = (process.argv[2] ?? 'http://localhost:8787/mcp').replace(/\/$/, '');

let sessionId = null;

async function rpc(body) {
	const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
	if (sessionId) headers['mcp-session-id'] = sessionId;
	const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
	sessionId ??= res.headers.get('mcp-session-id');
	const text = await res.text();
	if (!text) return null;
	// Streamable HTTP may answer as SSE; take the first data frame either way.
	const line = text.split('\n').find((l) => l.startsWith('data:'));
	return JSON.parse(line ? line.slice(5) : text);
}

async function callTool(name, args) {
	const res = await rpc({ jsonrpc: '2.0', id: Date.now() % 1e6, method: 'tools/call', params: { name, arguments: args } });
	const payload = JSON.parse(res.result.content[0].text);
	if (res.result.isError) throw new Error(`${name} failed: ${payload.speech ?? res.result.content[0].text}`);
	return payload;
}

const checks = [];
function check(label, ok, detail = '') {
	checks.push({ label, ok });
	console.log(`  ${ok ? '✓' : '✗'} ${label}${detail && !ok ? ` — ${detail}` : ''}`);
}

console.log(`\nSmoke test: ${endpoint}\n`);

const init = await rpc({
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'clinicdesk-smoke', version: '1.0' } },
});
check(`protocol ${init.result.protocolVersion}`, !!init.result.protocolVersion);
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
check(`${tools.result.tools.length} tools advertised`, tools.result.tools.length === 11, `got ${tools.result.tools.length}`);

// A tool that must reach the database — this is what a wiped secret breaks.
const info = await callTool('get_clinic_info', {});
check('get_clinic_info reaches the database', !!info.clinic?.emergency_phone);

// The three dispositions, live. Same cases as the unit tests, over the wire.
const cases = [
	['urgent', 'I am having trouble swallowing and my neck is swelling', 2],
	['expected', 'my cheek is a bit swollen and it aches', 1],
	['call_clinic', 'the pain is much worse today', 4],
];
for (const [expected, symptom, days] of cases) {
	const r = await callTool('check_symptom', { symptom, procedure: 'EXTRACTION', days_since: days });
	check(`${expected}: "${symptom}"`, r.disposition === expected, `got ${r.disposition}`);
	if (r.disposition !== expected) continue;
	check(`  speaks a full sentence`, typeof r.speech === 'string' && r.speech.length > 40);
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} passed\n`);
process.exit(failed ? 1 : 0);
