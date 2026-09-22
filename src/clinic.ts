/**
 * Thin PostgREST client for the clinic database, plus the scheduling and
 * triage logic the MCP tools sit on top of.
 *
 * Everything here is written for a voice host: functions return the data the
 * caller needs *and* a short `speech` line, because Alexa+ reads the result
 * aloud and a wall of JSON is unusable out loud.
 */

export interface Env {
	SUPABASE_URL: string;
	SUPABASE_SERVICE_KEY: string;
	CLINIC_TZ_OFFSET_MIN?: string;
}

export interface ClinicInfo {
	name: string;
	address: string;
	phone: string;
	emergency_phone: string;
	open_time: string;
	close_time: string;
	closed_days: number[];
}

export interface Procedure {
	code: string;
	name: string;
	minutes: number;
	aftercare_key: string | null;
	requires_provider_title: string | null;
}

export interface Provider {
	id: number;
	name: string;
	title: string;
	works_days: number[];
}

export interface Aftercare {
	key: string;
	procedure_label: string;
	summary: string;
	steps: string[];
	red_flags: string[];
	normal_for_days: number;
}

export class ClinicDb {
	constructor(private env: Env) {}

	private get base() {
		return this.env.SUPABASE_URL.replace(/\/+$/, '');
	}

	private headers(extra: Record<string, string> = {}) {
		return {
			apikey: this.env.SUPABASE_SERVICE_KEY,
			Authorization: `Bearer ${this.env.SUPABASE_SERVICE_KEY}`,
			'Content-Type': 'application/json',
			...extra,
		};
	}

	private async req<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
		const res = await fetch(`${this.base}/rest/v1/${path}`, {
			method,
			headers: this.headers(extra),
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!res.ok) {
			const detail = await res.text();
			throw new Error(`clinic database ${method} ${path.split('?')[0]} failed (${res.status}): ${detail.slice(0, 300)}`);
		}
		const text = await res.text();
		return (text ? JSON.parse(text) : null) as T;
	}

	get<T>(path: string) {
		return this.req<T>('GET', path);
	}

	post<T>(path: string, body: unknown, prefer = 'return=representation') {
		return this.req<T>('POST', path, body, { Prefer: prefer });
	}

	patch<T>(path: string, body: unknown) {
		return this.req<T>('PATCH', path, body, { Prefer: 'return=representation' });
	}

	async clinic(): Promise<ClinicInfo> {
		const rows = await this.get<ClinicInfo[]>('clinic_info?select=*&limit=1');
		if (!rows?.length) throw new Error('No clinic is configured on this server.');
		return rows[0];
	}

	procedures() {
		return this.get<Procedure[]>('clinic_procedures?select=*&order=name.asc');
	}

	providers() {
		return this.get<Provider[]>('clinic_providers?select=*&order=id.asc');
	}

	async procedureByCodeOrName(input: string): Promise<Procedure | null> {
		const all = await this.procedures();
		const q = input.trim().toLowerCase();
		return (
			all.find((p) => p.code.toLowerCase() === q) ??
			all.find((p) => p.name.toLowerCase() === q) ??
			all.find((p) => p.name.toLowerCase().includes(q)) ??
			all.find((p) => q.includes(p.name.toLowerCase().split(' ')[0])) ??
			null
		);
	}

	async patientByPhone(phone: string) {
		const rows = await this.get<any[]>(`clinic_patients?select=*&phone=eq.${encodeURIComponent(normalisePhone(phone))}`);
		return rows?.[0] ?? null;
	}
}

/** Phone numbers arrive from speech recognition in many shapes. Normalise hard. */
export function normalisePhone(raw: string): string {
	let p = (raw || '').replace(/[^\d+]/g, '');
	if (p.startsWith('00')) p = `+${p.slice(2)}`;
	if (!p.startsWith('+') && p.startsWith('0')) p = `+20${p.slice(1)}`;
	if (!p.startsWith('+')) p = `+${p}`;
	return p;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function speakDateTime(iso: string): string {
	const d = new Date(iso);
	const day = DAY_NAMES[d.getUTCDay()];
	const hh = d.getUTCHours();
	const mm = d.getUTCMinutes();
	const ampm = hh < 12 ? 'am' : 'pm';
	const h12 = hh % 12 === 0 ? 12 : hh % 12;
	const time = mm === 0 ? `${h12} ${ampm}` : `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;
	return `${day} the ${ordinal(d.getUTCDate())} at ${time}`;
}

function ordinal(n: number): string {
	const s = ['th', 'st', 'nd', 'rd'];
	const v = n % 100;
	return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Free slots across the next `days` days.
 *
 * Deliberately simple and explainable: clinic opening hours, minus closed days,
 * minus anything already booked for that provider, on a 15-minute grid.
 */
export function buildSlots(opts: {
	clinic: ClinicInfo;
	provider: Provider;
	minutes: number;
	busy: { starts_at: string; ends_at: string }[];
	fromUtcMs: number;
	days: number;
	limit: number;
}): string[] {
	const { clinic, provider, minutes, busy, fromUtcMs, days, limit } = opts;
	const [openH, openM] = clinic.open_time.split(':').map(Number);
	const [closeH, closeM] = clinic.close_time.split(':').map(Number);
	const busyRanges = busy.map((b) => [Date.parse(b.starts_at), Date.parse(b.ends_at)] as const);
	const out: string[] = [];

	const day0 = new Date(fromUtcMs);
	day0.setUTCHours(0, 0, 0, 0);

	for (let d = 0; d < days && out.length < limit; d++) {
		const dayStart = new Date(day0.getTime() + d * 86400000);
		const dow = dayStart.getUTCDay();
		if (clinic.closed_days.includes(dow)) continue;
		if (!provider.works_days.includes(dow)) continue;

		const open = Date.UTC(dayStart.getUTCFullYear(), dayStart.getUTCMonth(), dayStart.getUTCDate(), openH, openM);
		const close = Date.UTC(dayStart.getUTCFullYear(), dayStart.getUTCMonth(), dayStart.getUTCDate(), closeH, closeM);

		for (let t = open; t + minutes * 60000 <= close && out.length < limit; t += 15 * 60000) {
			if (t < fromUtcMs + 60 * 60000) continue; // never offer inside the next hour
			const end = t + minutes * 60000;
			const clash = busyRanges.some(([bs, be]) => t < be && end > bs);
			if (!clash) out.push(new Date(t).toISOString());
		}
	}
	return out;
}

/**
 * Symptom triage.
 *
 * This deliberately does NOT diagnose. It matches what the caller reports
 * against the red-flag list recorded by the clinic for that procedure and
 * returns one of three dispositions. Anything it does not recognise escalates
 * rather than reassures — the safe direction for an unsupervised voice channel.
 */
export type Disposition = 'expected' | 'call_clinic' | 'urgent';

/**
 * Triage vocabulary.
 *
 * Phrasing varies enormously in speech — "can't swallow", "trouble swallowing",
 * "hard to swallow" and "swallowing hurts so much I've stopped" are the same
 * emergency. So urgency is decided on CONCEPTS that co-occur, not on fixed
 * phrases. Each rule is (difficulty-word near body-concept) or a standalone
 * concept that is always an emergency.
 */
const NEGATIVE_QUALIFIER =
	/\b(?:can'?t|cant|cannot|unable|difficult|difficulty|trouble|hard|struggl\w*|painful|hurts?|stopped|barely|impossible|clos\w*|tight\w*|narrow\w*|block\w*|constrict\w*)\b/i;
const WORSENING = /\b(?:worse|worsening|worsened|increas\w*|spreading|bigger|growing|more (?:pain|swollen|swelling)|not (?:getting )?better|deteriorat\w*)\b/i;

/** Concepts that are an emergency whenever they appear at all. */
const ALWAYS_URGENT: [RegExp, string][] = [
	[/\bfever\b|\btemperature\b|\bshiver\w*|\brigor\w*|\bchills?\b/i, 'fever'],
	[/\bpus\b|\bdischarg\w*|\babscess\b/i, 'discharge or an abscess'],
	[/\bnumb\w*\b/i, 'numbness that has not worn off'],
];

/** Body concepts that are an emergency when a difficulty or swelling word is nearby. */
const AIRWAY = /\bswallow\w*|\bbreath\w*|\bairway\b|\bthroat\b|\bchok\w*/i;
const SPREAD_SITE = /\bneck\b|\bthroat\b|\beye\b|\bunder (?:my )?(?:chin|jaw)\b|\bfloor of (?:my )?mouth\b|\btongue (?:is )?rais\w*/i;
const SWELL = /\bswell\w*|\bswollen\b|\bpuff\w*/i;
const BLEED = /\bbleed\w*|\bblood\b/i;
const UNSTOPPABLE =
	/\b(?:wo|will|would|does|do|did|has|have|can|could)(?:n'?t|\s+not)\s+stop\w*|\bnot stopping\b|\bstill bleeding\b|\bkeeps? bleeding\b|\bsoak\w*|\bpour\w*|\bgush\w*|\bfilling (?:my |the )?mouth\b|\bheav(?:y|ily)\b/i;

const EXPECTED_PATTERNS: [RegExp, string][] = [
	[/\bmild\b|\bslight\w*|\ba (?:bit|little)\b/i, 'mild symptoms'],
	[/\bbrui[sz]\w*/i, 'bruising'],
	[/\bsensitiv\w*|\bcold\b|\bzing\w*/i, 'sensitivity'],
	[/\bache\w*|\bsore\w*|\btender\w*|\bdiscomfort\b/i, 'ache or tenderness'],
	[/\boo[sz]\w*|\bpink saliva\b/i, 'slight oozing'],
	[SWELL, 'swelling'],
];

/**
 * Does the text contain anything that must block a reassuring answer?
 * Used as a hard safety net: if this is true the result can never be
 * "expected", whatever else matched.
 */
function hasUrgentConcept(s: string): string | null {
	for (const [re, label] of ALWAYS_URGENT) if (re.test(s)) return label;
	if (AIRWAY.test(s) && (NEGATIVE_QUALIFIER.test(s) || SWELL.test(s))) return 'difficulty with breathing or swallowing';
	if (SPREAD_SITE.test(s) && SWELL.test(s)) return 'swelling spreading to the neck, throat or eye';
	if (BLEED.test(s) && UNSTOPPABLE.test(s)) return 'bleeding that will not stop';
	return null;
}

export function triage(opts: { symptom: string; daysSince: number; care: Aftercare | null }): {
	disposition: Disposition;
	reason: string;
	matchedRedFlag?: string;
} {
	const s = (opts.symptom || '').toLowerCase();

	// 1. Emergencies first, on concepts rather than phrasings.
	const urgent = hasUrgentConcept(s);
	if (urgent) return { disposition: 'urgent', reason: urgent };

	// 2. The clinic's own red flags for this procedure.
	if (opts.care) {
		for (const flag of opts.care.red_flags) {
			const words = flag.toLowerCase().match(/[a-z]{5,}/g) ?? [];
			const hits = words.filter((w) => s.includes(w)).length;
			if (hits >= 2) return { disposition: 'call_clinic', reason: 'this matches something the clinic asked to hear about', matchedRedFlag: flag };
		}
	}

	// 3. Anything getting worse late in recovery is the infection / dry-socket shape.
	if (WORSENING.test(s) && opts.daysSince >= 3) {
		return { disposition: 'call_clinic', reason: 'symptoms that worsen after day three are worth a call rather than waiting' };
	}

	// 4. Only now may we reassure — and only inside the documented normal window.
	const withinNormalWindow = opts.care ? opts.daysSince <= opts.care.normal_for_days : opts.daysSince <= 3;
	if (withinNormalWindow && !WORSENING.test(s)) {
		for (const [re, label] of EXPECTED_PATTERNS) {
			if (re.test(s)) {
				// Safety net: never reassure if any urgent concept is present at all.
				if (hasUrgentConcept(s)) break;
				return { disposition: 'expected', reason: label };
			}
		}
	}

	return { disposition: 'call_clinic', reason: 'I could not match this to the expected recovery pattern, so the clinic should hear it' };
}
