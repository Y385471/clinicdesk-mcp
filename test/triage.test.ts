/**
 * Clinical safety tests for the triage rules.
 *
 * The rule these encode: an unsupervised voice channel may under-reassure, but
 * it must never over-reassure. A false "that's normal" on a spreading infection
 * is the only failure here that can actually hurt someone, so the urgent cases
 * are written in many different phrasings — the way patients actually speak,
 * not the way a regex author imagines they speak.
 *
 * The first case in this file is a real bug that shipped and was caught in
 * testing: "trouble swallowing and my neck is swelling" originally returned
 * "expected", because the pattern only knew the phrase "can't swallow" and the
 * word "swelling" alone matched the normal-recovery list.
 */

import { describe, expect, it } from 'vitest';
import { normalisePhone, speakDateTime, triage, type Aftercare } from '../src/clinic';

const extraction: Aftercare = {
	key: 'extraction',
	procedure_label: 'tooth extraction',
	summary: 'Bite on gauze and keep the clot undisturbed.',
	steps: [],
	red_flags: [
		'Bleeding that soaks through gauze after 30 minutes of firm pressure',
		'Severe throbbing pain starting on day three or four that painkillers barely touch - this can be a dry socket',
		'Swelling that is still increasing after day three',
		'Fever above 38 C, or difficulty swallowing or opening the mouth',
	],
	normal_for_days: 3,
};

const filling: Aftercare = {
	key: 'filling',
	procedure_label: 'composite filling',
	summary: 'Sensitivity to cold is normal.',
	steps: [],
	red_flags: ['The bite still feels high after a day', 'Sharp pain on biting down'],
	normal_for_days: 14,
};

describe('triage — must escalate, however it is phrased', () => {
	const urgent: [string, number][] = [
		['I am having trouble swallowing and my neck is swelling', 2],
		["I can't swallow properly", 2],
		['it is hard to swallow now', 3],
		['swallowing hurts so much I stopped eating', 2],
		['my throat feels like it is closing', 1],
		['the swelling has gone down into my neck', 3],
		['my eye is puffy on that side', 3],
		['under my jaw is swollen and firm', 4],
		['I have a temperature of 38.5', 2],
		['I feel shivery', 2],
		['there is pus coming out', 5],
		['my lip is still numb', 2],
		['the bleeding will not stop', 0],
		["the bleeding won't stop", 0],
		['blood keeps filling my mouth', 0],
		['I am still bleeding heavily', 0],
	];

	it.each(urgent)('urgent: %s (day %i)', (symptom, daysSince) => {
		expect(triage({ symptom, daysSince, care: extraction }).disposition).toBe('urgent');
	});
});

describe('triage — may reassure only inside the documented normal window', () => {
	it.each([
		['my cheek is a bit swollen and it aches', 1],
		['slight bruising on my jaw', 2],
		['mild soreness', 1],
		['a little oozing when I spit', 1],
	])('expected: %s (day %i)', (symptom, daysSince) => {
		expect(triage({ symptom, daysSince, care: extraction }).disposition).toBe('expected');
	});

	it('reassures about cold sensitivity well into a filling recovery', () => {
		expect(triage({ symptom: 'my tooth is sensitive to cold', daysSince: 5, care: filling }).disposition).toBe('expected');
	});

	it('stops reassuring once past the documented window', () => {
		expect(triage({ symptom: 'mild swelling', daysSince: 9, care: extraction }).disposition).toBe('call_clinic');
	});

	it('never reassures about something that is getting worse, even on day one', () => {
		expect(triage({ symptom: 'mild swelling but it is getting worse', daysSince: 1, care: extraction }).disposition).not.toBe('expected');
	});
});

describe('triage — routes the rest to the clinic rather than guessing', () => {
	it.each([
		['the pain is much worse today and painkillers are not touching it', 4],
		['the swelling is getting bigger', 4],
		['there is a strange metallic smell', 6],
		['the swelling is worse on day five', 5],
	])('call_clinic: %s (day %i)', (symptom, daysSince) => {
		expect(triage({ symptom, daysSince, care: extraction }).disposition).toBe('call_clinic');
	});

	it('escalates an unrecognised symptom instead of reassuring', () => {
		const r = triage({ symptom: 'my jaw makes a clicking noise now', daysSince: 1, care: extraction });
		expect(r.disposition).toBe('call_clinic');
	});

	it('still escalates when no aftercare sheet exists for the procedure', () => {
		expect(triage({ symptom: 'something feels wrong', daysSince: 1, care: null }).disposition).toBe('call_clinic');
	});

	it('quotes the clinic red flag it matched, so the patient hears their own clinic', () => {
		const r = triage({ symptom: 'severe throbbing pain and painkillers barely help', daysSince: 4, care: extraction });
		expect(r.disposition).toBe('call_clinic');
		expect(r.matchedRedFlag).toContain('dry socket');
	});
});

describe('phone normalisation — speech recognition produces many shapes', () => {
	it.each([
		['01001234567', '+201001234567'],
		['+20 100 123 4567', '+201001234567'],
		['0020 100 123 4567', '+201001234567'],
		['(0100) 123-4567', '+201001234567'],
	])('%s -> %s', (input, expected) => {
		expect(normalisePhone(input)).toBe(expected);
	});
});

describe('spoken date formatting', () => {
	it('reads a time the way a receptionist says it', () => {
		expect(speakDateTime('2026-09-24T09:00:00.000Z')).toBe('Thursday the 24th at 9 am');
	});
	it('includes minutes only when there are some', () => {
		expect(speakDateTime('2026-09-24T14:15:00.000Z')).toBe('Thursday the 24th at 2:15 pm');
	});
});
