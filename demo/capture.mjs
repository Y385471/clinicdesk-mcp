// Records the real server's answers for the demo video. Nothing in the video is
// scripted on the Alexa side: every `speech` line below is what production
// returned at capture time.
import { writeFileSync } from 'node:fs';

const EP = 'https://clinicdesk-mcp.vercel.app/mcp';
let id = 0;
async function rpc(method, params) {
	const r = await fetch(EP, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
		body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
	});
	const t = await r.text();
	const line = t.split('\n').find((l) => l.startsWith('data:'));
	return JSON.parse(line ? line.slice(5) : t);
}
async function call(name, args) {
	const r = await rpc('tools/call', { name, arguments: args });
	return { name, args, result: JSON.parse(r.result.content[0].text), isError: !!r.result.isError };
}

const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'demo-capture', version: '1' } });
const tools = await rpc('tools/list', {});

const t1 = await call('check_symptom', { symptom: 'I had a tooth out yesterday and my cheek is swollen', procedure: 'EXTRACTION', days_since: 1 });
const t2 = await call('check_symptom', { symptom: "I'm having trouble swallowing and my neck is swelling", procedure: 'EXTRACTION', days_since: 2 });
const t3 = await call('find_appointment_slots', { procedure: 'CHECKUP', days_ahead: 7, limit: 3 });
const t4 = await call('find_patient', { phone: '0100 123 4567' });
const slot = t3.result.slots[0];
const t5 = await call('book_appointment', { patient_id: t4.result.patient_id, procedure: 'CHECKUP', starts_at: slot.starts_at, provider_id: slot.provider_id });

const out = {
	captured_at: new Date().toISOString(),
	protocol: init.result.protocolVersion,
	tool_count: tools.result.tools.length,
	turns: [t1, t2, t3, t4, t5].map((t) => ({ name: t.name, args: t.args, speech: t.result.speech, disposition: t.result.disposition ?? null, isError: t.isError })),
};
writeFileSync(new URL('./data.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
