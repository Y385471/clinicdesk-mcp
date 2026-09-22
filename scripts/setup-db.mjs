#!/usr/bin/env node
/**
 * Creates the ClinicDesk tables in a Supabase project and seeds a demo clinic.
 *
 * Reads SUPABASE_URL and SUPABASE_SERVICE_KEY from .dev.vars (or the
 * environment). Supabase has no SQL-over-REST endpoint, so this prints the
 * schema for you to paste into the SQL editor once, then seeds the reference
 * data over PostgREST — which is the part you would otherwise do by hand.
 *
 *   npm run db:setup            # print schema, then seed
 *   npm run db:setup -- --seed  # skip the schema, seed only
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
	let url = process.env.SUPABASE_URL;
	let key = process.env.SUPABASE_SERVICE_KEY;
	try {
		const raw = readFileSync(join(root, '.dev.vars'), 'utf8');
		for (const line of raw.split('\n')) {
			const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
			if (!m) continue;
			if (m[1] === 'SUPABASE_URL') url ||= m[2];
			if (m[1] === 'SUPABASE_SERVICE_KEY') key ||= m[2];
		}
	} catch {
		/* .dev.vars is optional if the env is already set */
	}
	if (!url || !key) {
		console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY. Copy .dev.vars.example to .dev.vars and fill it in.');
		process.exit(1);
	}
	return { url: url.replace(/\/+$/, ''), key };
}

const SCHEMA = `
create table if not exists clinic_patients (
  id bigserial primary key,
  full_name text not null,
  phone text not null unique,
  date_of_birth date,
  medical_flags text[] default '{}',
  created_at timestamptz not null default now()
);
create table if not exists clinic_providers (
  id bigserial primary key, name text not null unique, title text not null,
  works_days int[] not null default '{0,1,2,3,4}'
);
create table if not exists clinic_procedures (
  code text primary key, name text not null, minutes int not null,
  aftercare_key text, requires_provider_title text
);
create table if not exists clinic_appointments (
  id bigserial primary key,
  patient_id bigint references clinic_patients(id) on delete cascade,
  provider_id bigint references clinic_providers(id),
  procedure_code text references clinic_procedures(code),
  starts_at timestamptz not null, ends_at timestamptz not null,
  status text not null default 'booked', note text,
  created_at timestamptz not null default now()
);
create table if not exists clinic_aftercare (
  key text primary key, procedure_label text not null,
  summary text not null, steps text[] not null,
  red_flags text[] not null, normal_for_days int not null default 3
);
create table if not exists clinic_callbacks (
  id bigserial primary key, patient_phone text not null, reason text not null,
  urgency text not null default 'routine',
  created_at timestamptz not null default now(), handled boolean default false
);
create table if not exists clinic_info (
  id int primary key default 1, name text not null, address text not null,
  phone text not null, emergency_phone text not null,
  open_time text not null, close_time text not null,
  closed_days int[] not null default '{5}'
);
alter table clinic_patients    enable row level security;
alter table clinic_appointments enable row level security;
alter table clinic_callbacks   enable row level security;
`.trim();

const CLINIC = {
	id: 1,
	name: 'Nile Dental Care',
	address: '12 El-Nasr Road, Nasr City, Cairo',
	phone: '+20 2 2404 1180',
	emergency_phone: '+20 100 555 0199',
	open_time: '09:00',
	close_time: '19:00',
	closed_days: [5],
};

const PROVIDERS = [
	{ name: 'Dr. Yousef Emad', title: 'General and restorative dentistry', works_days: [0, 1, 2, 3, 4] },
	{ name: 'Dr. Hala Mansour', title: 'Oral surgery', works_days: [0, 2, 4] },
	{ name: 'Dr. Karim Nabil', title: 'Orthodontics', works_days: [1, 3, 6] },
];

const PROCEDURES = [
	{ code: 'CHECKUP', name: 'Routine check-up and cleaning', minutes: 30, aftercare_key: null, requires_provider_title: null },
	{ code: 'FILLING', name: 'Composite filling', minutes: 45, aftercare_key: 'filling', requires_provider_title: null },
	{ code: 'ROOTCANAL', name: 'Root canal treatment', minutes: 90, aftercare_key: 'rootcanal', requires_provider_title: null },
	{ code: 'EXTRACTION', name: 'Tooth extraction', minutes: 45, aftercare_key: 'extraction', requires_provider_title: 'Oral surgery' },
	{ code: 'WISDOM', name: 'Wisdom tooth extraction', minutes: 75, aftercare_key: 'extraction', requires_provider_title: 'Oral surgery' },
	{ code: 'IMPLANT', name: 'Dental implant placement', minutes: 120, aftercare_key: 'implant', requires_provider_title: 'Oral surgery' },
	{ code: 'CROWN', name: 'Crown fitting', minutes: 60, aftercare_key: 'crown', requires_provider_title: null },
	{ code: 'WHITENING', name: 'In-clinic whitening', minutes: 60, aftercare_key: 'whitening', requires_provider_title: null },
	{ code: 'ORTHO', name: 'Orthodontic adjustment', minutes: 30, aftercare_key: null, requires_provider_title: 'Orthodontics' },
];

/**
 * Aftercare protocols. This is clinical content, written by a practising
 * dentist — it is the part a general model must not improvise. It lives in the
 * database so a practice can amend it without a code change.
 */
const AFTERCARE = [
	{
		key: 'extraction',
		procedure_label: 'tooth extraction',
		summary: 'Bite on gauze, keep the clot undisturbed, and expect swelling to peak on day two.',
		steps: [
			'Bite firmly on the gauze for 45 minutes without checking it. Checking early restarts the bleeding.',
			'No rinsing, spitting, smoking or drinking through a straw for 24 hours. Suction can pull out the clot.',
			'Cold compress on the cheek, 15 minutes on and 15 off, for the first day. Switch to warm from day two.',
			'Eat soft, cool food. Chew on the other side.',
			'From day two, rinse gently with warm salty water after meals.',
			'Take the painkiller you were prescribed before the numbness wears off, not after.',
		],
		red_flags: [
			'Bleeding that soaks through gauze after 30 minutes of firm pressure',
			'Severe throbbing pain starting on day three or four that painkillers barely touch - this can be a dry socket',
			'Swelling that is still increasing after day three',
			'Fever above 38 C, or difficulty swallowing or opening the mouth',
		],
		normal_for_days: 3,
	},
	{
		key: 'implant',
		procedure_label: 'dental implant placement',
		summary: 'Protect the site completely for the first week so the bone can begin to fuse with the implant.',
		steps: [
			'Do not disturb the surgical site with your tongue, a finger, or a toothbrush.',
			'No rinsing or spitting for 24 hours, then gentle salt-water rinses only.',
			'Cold compress for the first 24 hours; swelling usually peaks on day two.',
			'Soft diet for a week. Nothing hard, crunchy or very hot on that side.',
			'Take any prescribed antibiotic to the end of the course, even once you feel fine.',
			'No smoking. Smoking is the single largest risk factor for early implant failure.',
		],
		red_flags: [
			'The implant or its cover screw feels loose or moves',
			'Numbness in the lip or chin that has not faded by the next day',
			'Pus, a persistent bad taste, or swelling that worsens after day three',
			'Fever above 38 C',
		],
		normal_for_days: 5,
	},
	{
		key: 'rootcanal',
		procedure_label: 'root canal treatment',
		summary: 'Mild tenderness when biting is expected while the tooth settles. The temporary filling must stay intact.',
		steps: [
			'Avoid chewing on that tooth until the permanent filling or crown is fitted.',
			'Tenderness on biting for a few days is normal and settles.',
			'Take an anti-inflammatory painkiller if you were told you can have one.',
			'Keep brushing normally, including that tooth.',
		],
		red_flags: [
			'The temporary filling comes out or breaks',
			'Swelling of the face or gum',
			'Pain that gets worse rather than better after day three',
			'Fever, or a bad taste that keeps coming back',
		],
		normal_for_days: 4,
	},
	{
		key: 'filling',
		procedure_label: 'composite filling',
		summary: 'You can eat as soon as the numbness is gone. Sensitivity to cold for a couple of weeks is normal.',
		steps: [
			'Wait until the numbness wears off before eating so you do not bite your cheek or tongue.',
			'Cold sensitivity for up to two weeks is normal and fades.',
			'If the bite feels high or uneven when you close, ring us - it is a two-minute adjustment.',
		],
		red_flags: ['The bite still feels high after a day', 'Sharp pain on biting down', 'Lingering pain to hot that lasts more than 30 seconds'],
		normal_for_days: 14,
	},
	{
		key: 'crown',
		procedure_label: 'crown fitting',
		summary: 'Treat a temporary crown gently until the permanent one is cemented.',
		steps: [
			'Avoid sticky and hard food on that side while the temporary crown is in place.',
			'Floss by pulling the floss out sideways, not up, so you do not lift the temporary off.',
			'Mild gum tenderness around the crown for a few days is normal.',
		],
		red_flags: ['The temporary crown comes off', 'Pain to hot or cold that lingers', 'The bite feels high'],
		normal_for_days: 5,
	},
	{
		key: 'whitening',
		procedure_label: 'in-clinic whitening',
		summary: 'Short bursts of sensitivity are normal. Avoid staining food and drink for 48 hours.',
		steps: [
			'For 48 hours avoid coffee, tea, red wine, cola, curry, tomato sauce and smoking.',
			'Zingy sensitivity for a day or two is expected; a sensitive toothpaste helps.',
			'Use lukewarm rather than very cold drinks for the first day.',
		],
		red_flags: ['Sensitivity that is still severe after three days', 'White patches or ulceration on the gum that do not settle in 48 hours'],
		normal_for_days: 2,
	},
];

const PATIENTS = [
	{ full_name: 'Mona Farouk', phone: '+201001234567', date_of_birth: '1989-04-12', medical_flags: ['penicillin allergy'] },
	{ full_name: 'Ahmed Saad', phone: '+201112223344', date_of_birth: '1976-11-02', medical_flags: ['type 2 diabetes', 'on warfarin'] },
	{ full_name: 'Salma Adel', phone: '+201223334455', date_of_birth: '1998-07-25', medical_flags: [] },
];

async function upsert(env, table, rows, conflict) {
	const q = conflict ? `?on_conflict=${conflict}` : '';
	const res = await fetch(`${env.url}/rest/v1/${table}${q}`, {
		method: 'POST',
		headers: {
			apikey: env.key,
			Authorization: `Bearer ${env.key}`,
			'Content-Type': 'application/json',
			Prefer: 'resolution=merge-duplicates,return=minimal',
		},
		body: JSON.stringify(rows),
	});
	if (!res.ok) {
		const body = await res.text();
		if (/does not exist/i.test(body)) {
			console.error(`\n✗ Table "${table}" does not exist yet.\n  Paste the schema above into the Supabase SQL editor, then re-run with --seed.\n`);
			process.exit(1);
		}
		throw new Error(`${table}: ${res.status} ${body.slice(0, 200)}`);
	}
	console.log(`  ✓ ${table} (${rows.length})`);
}

const env = loadEnv();
const seedOnly = process.argv.includes('--seed');

if (!seedOnly) {
	console.log('\n── Step 1. Paste this into the Supabase SQL editor ──────────────\n');
	console.log(SCHEMA);
	console.log('\n─────────────────────────────────────────────────────────────────');
	console.log('Then press Run. Seeding the reference data now...\n');
}

console.log('Seeding reference data:');
await upsert(env, 'clinic_info', [CLINIC], 'id');
await upsert(env, 'clinic_providers', PROVIDERS, 'name');
await upsert(env, 'clinic_procedures', PROCEDURES, 'code');
await upsert(env, 'clinic_aftercare', AFTERCARE, 'key');
await upsert(env, 'clinic_patients', PATIENTS, 'phone');
console.log('\nDone. Run `npm run dev` and connect an MCP client to http://localhost:8787/mcp\n');
