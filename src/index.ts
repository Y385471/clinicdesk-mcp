/**
 * ClinicDesk MCP — a self-hosted Model Context Protocol server that turns a
 * dental clinic's booking system and aftercare protocols into tools an
 * assistant like Alexa+ can call out loud.
 *
 * Transport: Streamable HTTP at /mcp (spec revision 2025-11-25).
 *
 * Design note that drives everything below: the caller is speaking, not typing.
 * A patient at 2am with a bleeding socket cannot read JSON and cannot type.
 * So every tool returns a short `speech` line meant to be read aloud verbatim,
 * with the structured data alongside it for any host that wants to render.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import { ClinicDb, buildSlots, normalisePhone, speakDateTime, triage, type Aftercare, type Env } from './clinic';
import { LANDING_HTML } from './landing';

/** Wrap a result so the voice line is always the first thing the host sees. */
function say(speech: string, data?: Record<string, unknown>) {
	const payload = { speech, ...(data ?? {}) };
	return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(speech: string, data?: Record<string, unknown>) {
	return { ...say(speech, data), isError: true as const };
}

export class ClinicDeskMCP extends McpAgent<Env> {
	server = new McpServer(
		{ name: 'clinicdesk', version: '1.0.0' },
		{
			instructions: [
				'You are the voice of a dental clinic front desk and its after-hours aftercare line.',
				'',
				'Every tool returns a `speech` field. Read that aloud as written — it is already',
				'phrased for the ear and has been checked for clinical accuracy. Do not paraphrase',
				'clinical instructions, do not add advice of your own, and never invent a symptom',
				'answer that check_symptom did not give you.',
				'',
				'Patients are identified by phone number. Call find_patient first when you have one.',
				'Before booking, call find_appointment_slots — appointment times are not guessable.',
				'If check_symptom returns disposition "urgent", say the emergency line immediately and',
				'do not continue with booking chit-chat.',
			].join('\n'),
		},
	);

	private db!: ClinicDb;

	async init() {
		this.db = new ClinicDb(this.env);
		const db = this.db;

		// ---------------------------------------------------------------- info

		this.server.registerTool(
			'get_clinic_info',
			{
				title: 'Clinic details',
				description:
					'Name, address, phone, emergency number, opening hours and closed days for the clinic. Call this when the patient asks where we are, when we open, or how to reach us out of hours.',
				inputSchema: {},
				annotations: { readOnlyHint: true, openWorldHint: false },
			},
			async () => {
				const c = await db.clinic();
				const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
				const closed = c.closed_days.map((d) => days[d]).join(' and ');
				return say(
					`${c.name} is on ${c.address}. We are open ${c.open_time} to ${c.close_time}, closed ${closed}. The clinic number is ${c.phone}, and the out-of-hours emergency line is ${c.emergency_phone}.`,
					{ clinic: c },
				);
			},
		);

		this.server.registerTool(
			'list_procedures',
			{
				title: 'Treatments offered',
				description:
					'Every treatment the clinic books, with how long each appointment takes. Use this to map what the patient described ("my filling fell out", "I need a clean") onto a bookable procedure code.',
				inputSchema: {},
				annotations: { readOnlyHint: true, openWorldHint: false },
			},
			async () => {
				const procs = await db.procedures();
				return say(
					`We book ${procs.length} treatments, from a thirty-minute check-up to a two-hour implant placement.`,
					{ procedures: procs.map((p) => ({ code: p.code, name: p.name, minutes: p.minutes })) },
				);
			},
		);

		// ------------------------------------------------------------- patient

		this.server.registerTool(
			'find_patient',
			{
				title: 'Look up a patient by phone',
				description:
					'Find a registered patient from their phone number. Returns the patient id needed for booking, and any medical flags on file (allergies, anticoagulants, diabetes) that the clinician must know about. Call this before booking or before answering a symptom question.',
				inputSchema: {
					phone: z.string().describe('Patient phone number in any format; spoken digits are fine.'),
				},
				annotations: { readOnlyHint: true, openWorldHint: false },
			},
			async ({ phone }) => {
				const p = await db.patientByPhone(phone);
				if (!p) {
					return say(`I could not find anyone registered on ${normalisePhone(phone)}. I can register you — I just need your full name and date of birth.`, {
						found: false,
						normalised_phone: normalisePhone(phone),
					});
				}
				const flags: string[] = p.medical_flags ?? [];
				return say(
					flags.length
						? `Found you, ${p.full_name}. I can see a note on your file about ${flags.join(' and ')}, so I will flag that to the dentist.`
						: `Found you, ${p.full_name}.`,
					{ found: true, patient_id: p.id, full_name: p.full_name, phone: p.phone, medical_flags: flags },
				);
			},
		);

		this.server.registerTool(
			'register_patient',
			{
				title: 'Register a new patient',
				description:
					'Create a patient record. Only call this after find_patient has come back empty. Medical flags are free text the patient volunteers — allergies, blood thinners, diabetes, pregnancy.',
				inputSchema: {
					full_name: z.string().min(2).describe('Patient full name as they say it.'),
					phone: z.string().describe('Phone number in any format.'),
					date_of_birth: z.string().optional().describe('YYYY-MM-DD if given.'),
					medical_flags: z.array(z.string()).optional().describe('Allergies or conditions the patient mentions.'),
				},
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
			},
			async ({ full_name, phone, date_of_birth, medical_flags }) => {
				const normalised = normalisePhone(phone);
				const existing = await db.patientByPhone(normalised);
				if (existing) {
					return say(`${existing.full_name} is already registered on that number, so I will use that record.`, {
						created: false,
						patient_id: existing.id,
					});
				}
				const rows = await db.post<any[]>('clinic_patients', [
					{ full_name, phone: normalised, date_of_birth: date_of_birth ?? null, medical_flags: medical_flags ?? [] },
				]);
				return say(`Thanks ${full_name}, you are registered on ${normalised}.`, { created: true, patient_id: rows[0].id });
			},
		);

		// ------------------------------------------------------------ booking

		this.server.registerTool(
			'find_appointment_slots',
			{
				title: 'Find free appointment times',
				description:
					'Free appointment times for a treatment over the next few days, respecting opening hours, closed days, which clinician does that treatment, and what is already booked. Always call this before book_appointment — slot times are not guessable. Offer the patient two or three, not the whole list.',
				inputSchema: {
					procedure: z.string().describe('Procedure code or name, e.g. EXTRACTION or "wisdom tooth".'),
					days_ahead: z.number().int().min(1).max(30).default(7).describe('How far ahead to look.'),
					limit: z.number().int().min(1).max(10).default(5).describe('How many slots to return.'),
				},
				annotations: { readOnlyHint: true, openWorldHint: false },
			},
			async ({ procedure, days_ahead, limit }) => {
				const proc = await db.procedureByCodeOrName(procedure);
				if (!proc) return fail(`I do not have a treatment called ${procedure}. Shall I read you what we book?`, { procedure_found: false });

				const clinic = await db.clinic();
				const providers = await db.providers();
				const eligible = proc.requires_provider_title
					? providers.filter((p) => p.title === proc.requires_provider_title)
					: providers;
				if (!eligible.length) return fail(`No clinician here does ${proc.name} at the moment.`, { procedure_found: true });

				const now = Date.now();
				const horizon = new Date(now + days_ahead * 86400000).toISOString();
				const booked = await db.get<any[]>(
					`clinic_appointments?select=provider_id,starts_at,ends_at&status=eq.booked&starts_at=lte.${horizon}&starts_at=gte.${new Date(now).toISOString()}`,
				);

				const slots: { starts_at: string; provider_id: number; provider: string; spoken: string }[] = [];
				for (const prov of eligible) {
					const busy = booked.filter((b) => b.provider_id === prov.id);
					for (const iso of buildSlots({ clinic, provider: prov, minutes: proc.minutes, busy, fromUtcMs: now, days: days_ahead, limit })) {
						slots.push({ starts_at: iso, provider_id: prov.id, provider: prov.name, spoken: speakDateTime(iso) });
					}
				}
				slots.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
				const top = slots.slice(0, limit);

				if (!top.length) return say(`I have nothing free for ${proc.name} in the next ${days_ahead} days. Shall I look further ahead?`, { slots: [] });

				const spokenTwo = top.slice(0, 2).map((s) => `${s.spoken} with ${s.provider}`).join(', or ');
				return say(`For ${proc.name}, which takes about ${proc.minutes} minutes, I have ${spokenTwo}. Would either of those work?`, {
					procedure: { code: proc.code, name: proc.name, minutes: proc.minutes },
					slots: top,
				});
			},
		);

		this.server.registerTool(
			'book_appointment',
			{
				title: 'Book an appointment',
				description:
					'Book a slot returned by find_appointment_slots. Re-checks the slot is still free before writing, so two callers cannot take the same time. Confirm the day and time back to the patient after this succeeds.',
				inputSchema: {
					patient_id: z.number().int().describe('From find_patient or register_patient.'),
					procedure: z.string().describe('Procedure code, e.g. EXTRACTION.'),
					starts_at: z.string().describe('Exact ISO 8601 start time taken from find_appointment_slots.'),
					provider_id: z.number().int().describe('Provider id from the same slot.'),
					note: z.string().optional().describe('Anything the patient wants the dentist to know.'),
				},
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
			},
			async ({ patient_id, procedure, starts_at, provider_id, note }) => {
				const proc = await db.procedureByCodeOrName(procedure);
				if (!proc) return fail(`I do not recognise the treatment ${procedure}.`);

				const start = Date.parse(starts_at);
				if (Number.isNaN(start)) return fail('That start time is not a valid date.');
				if (start < Date.now()) return fail('That time is in the past — let me find you a new one.');
				const ends = new Date(start + proc.minutes * 60000).toISOString();

				const clash = await db.get<any[]>(
					`clinic_appointments?select=id&status=eq.booked&provider_id=eq.${provider_id}&starts_at=lt.${encodeURIComponent(ends)}&ends_at=gt.${encodeURIComponent(new Date(start).toISOString())}`,
				);
				if (clash.length) return fail('Someone just took that slot. Let me find you another time.', { slot_taken: true });

				const rows = await db.post<any[]>('clinic_appointments', [
					{ patient_id, provider_id, procedure_code: proc.code, starts_at: new Date(start).toISOString(), ends_at: ends, note: note ?? null },
				]);
				const provider = (await db.providers()).find((p) => p.id === provider_id);
				return say(`Booked. ${proc.name} on ${speakDateTime(rows[0].starts_at)} with ${provider?.name ?? 'the clinician'}. Anything else?`, {
					appointment_id: rows[0].id,
					starts_at: rows[0].starts_at,
					procedure: proc.name,
					provider: provider?.name,
				});
			},
		);

		this.server.registerTool(
			'get_my_appointments',
			{
				title: 'Upcoming appointments',
				description: 'Upcoming booked appointments for a patient, by phone number. Use it for "when am I in?" and before rescheduling or cancelling.',
				inputSchema: { phone: z.string().describe('Patient phone number in any format.') },
				annotations: { readOnlyHint: true, openWorldHint: false },
			},
			async ({ phone }) => {
				const p = await db.patientByPhone(phone);
				if (!p) return say(`I have no record on ${normalisePhone(phone)}.`, { found: false });
				const rows = await db.get<any[]>(
					`clinic_appointments?select=id,starts_at,status,procedure_code,provider_id&patient_id=eq.${p.id}&status=eq.booked&starts_at=gte.${new Date().toISOString()}&order=starts_at.asc`,
				);
				if (!rows.length) return say(`${p.full_name}, you have nothing booked with us at the moment.`, { appointments: [] });
				const procs = await db.procedures();
				const list = rows.map((r) => ({
					appointment_id: r.id,
					starts_at: r.starts_at,
					spoken: speakDateTime(r.starts_at),
					procedure: procs.find((x) => x.code === r.procedure_code)?.name ?? r.procedure_code,
				}));
				return say(`You have ${list.length === 1 ? 'one appointment' : `${list.length} appointments`} — the next is ${list[0].procedure} on ${list[0].spoken}.`, {
					patient: p.full_name,
					appointments: list,
				});
			},
		);

		this.server.registerTool(
			'cancel_appointment',
			{
				title: 'Cancel an appointment',
				description:
					'Cancel a booked appointment by its id. Always read the day and time back and get a clear yes before calling this — it frees the slot for someone else immediately.',
				inputSchema: {
					appointment_id: z.number().int().describe('From get_my_appointments.'),
					reason: z.string().optional().describe('Why, if the patient says.'),
				},
				annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
			},
			async ({ appointment_id, reason }) => {
				const found = await db.get<any[]>(`clinic_appointments?select=*&id=eq.${appointment_id}`);
				if (!found.length) return fail(`I cannot find appointment ${appointment_id}.`);
				if (found[0].status !== 'booked') return say(`That appointment was already ${found[0].status}.`, { already: found[0].status });
				await db.patch<any[]>(`clinic_appointments?id=eq.${appointment_id}`, { status: 'cancelled', note: reason ?? found[0].note });
				return say(`Cancelled your appointment on ${speakDateTime(found[0].starts_at)}. Would you like me to rebook you?`, {
					cancelled_id: appointment_id,
					was: found[0].starts_at,
				});
			},
		);

		// ----------------------------------------------------------- aftercare

		this.server.registerTool(
			'get_aftercare',
			{
				title: 'Aftercare instructions',
				description:
					'The clinic\'s own aftercare protocol for a treatment: what to do, and the warning signs that mean ring us. Read the steps in order. These are the clinic\'s words — do not summarise them away or add your own advice.',
				inputSchema: {
					procedure: z.string().describe('Procedure code or name, e.g. EXTRACTION or "implant".'),
				},
				annotations: { readOnlyHint: true, openWorldHint: false },
			},
			async ({ procedure }) => {
				const care = await lookupAftercare(db, procedure);
				if (!care) return fail(`I do not have a written aftercare sheet for ${procedure}. Please ring the clinic and we will talk you through it.`);
				return say(`After a ${care.procedure_label}: ${care.summary} I can read you the full list of steps, and the signs that mean you should call us.`, {
					procedure: care.procedure_label,
					summary: care.summary,
					steps: care.steps,
					warning_signs: care.red_flags,
					normal_recovery_days: care.normal_for_days,
				});
			},
		);

		this.server.registerTool(
			'check_symptom',
			{
				title: 'Is this normal after my treatment?',
				description:
					'Check a symptom the patient reports against the clinic\'s recorded red flags for their treatment. Returns one of three dispositions: expected, call_clinic, or urgent. This does not diagnose and never reassures about anything it does not recognise — unmatched symptoms escalate. Read the `speech` field exactly as written and do not soften it.',
				inputSchema: {
					symptom: z.string().describe('What the patient says, in their own words.'),
					procedure: z.string().describe('The treatment they had, code or name.'),
					days_since: z.number().int().min(0).max(60).describe('Days since the treatment.'),
				},
				annotations: { readOnlyHint: true, openWorldHint: false },
			},
			async ({ symptom, procedure, days_since }) => {
				const clinic = await db.clinic();
				const care = await lookupAftercare(db, procedure);
				const result = triage({ symptom, daysSince: days_since, care });

				if (result.disposition === 'urgent') {
					return say(
						`That needs to be seen now, not tomorrow. Please call the emergency line on ${clinic.emergency_phone} straight away, and if you are struggling to breathe or swallow, go to the nearest emergency department instead of waiting for a call back.`,
						{ disposition: 'urgent', matched: result.reason, emergency_phone: clinic.emergency_phone },
					);
				}
				if (result.disposition === 'call_clinic') {
					return say(
						`I would not leave that one. ${result.matchedRedFlag ? `The clinic specifically asks to hear about ${lower(result.matchedRedFlag)}.` : capitalise(result.reason) + '.'} Please ring us on ${clinic.phone} during opening hours, or ${clinic.emergency_phone} if we are closed. Shall I log a callback request for you?`,
						{ disposition: 'call_clinic', reason: result.reason, matched_red_flag: result.matchedRedFlag ?? null, phone: clinic.phone },
					);
				}
				return say(
					`${capitalise(result.reason)} on day ${days_since} after a ${care?.procedure_label ?? procedure} is within what we expect, so nothing is going wrong. Keep going with the aftercare. Call us on ${clinic.phone} if it changes direction and starts getting worse instead of better.`,
					{ disposition: 'expected', reason: result.reason, normal_recovery_days: care?.normal_for_days ?? null },
				);
			},
		);

		this.server.registerTool(
			'request_callback',
			{
				title: 'Ask the clinic to call back',
				description:
					'Log a callback request for the clinic team. Use it whenever check_symptom says call_clinic, or when the patient wants a human. Set urgency to "urgent" only when check_symptom returned urgent.',
				inputSchema: {
					phone: z.string().describe('Number to call back on.'),
					reason: z.string().describe('What it is about, in one line.'),
					urgency: z.enum(['routine', 'same_day', 'urgent']).default('routine'),
				},
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
			},
			async ({ phone, reason, urgency }) => {
				const clinic = await db.clinic();
				const rows = await db.post<any[]>('clinic_callbacks', [{ patient_phone: normalisePhone(phone), reason, urgency }]);
				const when = urgency === 'urgent' ? 'straight away' : urgency === 'same_day' ? 'today' : 'on our next working day';
				return say(
					urgency === 'urgent'
						? `I have flagged this as urgent for the team. If anything worsens before they reach you, call ${clinic.emergency_phone} directly.`
						: `Done — the team will call you back ${when} on ${normalisePhone(phone)}.`,
					{ callback_id: rows[0].id, urgency },
				);
			},
		);
	}
}

async function lookupAftercare(db: ClinicDb, procedure: string): Promise<Aftercare | null> {
	const proc = await db.procedureByCodeOrName(procedure);
	const key = proc?.aftercare_key ?? procedure.trim().toLowerCase();
	const rows = await db.get<Aftercare[]>(`clinic_aftercare?select=*&key=eq.${encodeURIComponent(key)}`);
	return rows?.[0] ?? null;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === '/mcp') {
			return ClinicDeskMCP.serve('/mcp').fetch(request, env, ctx);
		}
		if (url.pathname === '/health') {
			return Response.json({ ok: true, server: 'clinicdesk', transport: 'streamable-http', endpoint: '/mcp' });
		}
		if (url.pathname === '/') {
			return new Response(LANDING_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
		}
		return new Response('Not found. The MCP endpoint is /mcp.', { status: 404 });
	},
};
