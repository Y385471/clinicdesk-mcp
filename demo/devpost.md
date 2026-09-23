# ClinicDesk MCP

## Elevator pitch (≤200 chars)
An Alexa+ MCP server for dental clinics: books appointments by voice, and answers the 2am "is this normal?" by reading back the clinic's own protocol — never guessing.

## About the project

### Inspiration
I am a practising dentist. The call every clinic dreads is not during opening hours. It is 2am, a patient had a tooth out that morning, the gauze is soaked, their cheek is swollen, and the clinic closed at seven. They do not know whether this is normal or an emergency, so they search, land on a forum, and either panic about nothing or ignore something that needed a hospital.

Voice is genuinely the right interface for that moment — their mouth hurts and their hands are busy holding gauze. But a general assistant improvising from training data is exactly the wrong thing to put there. So ClinicDesk makes Alexa+ read back the clinic's own written protocol, and nothing else.

### What it does
ClinicDesk is a self-hosted MCP server (spec **2025-11-25**, **Streamable HTTP**) with 11 tools across two jobs:

**Front desk** — `get_clinic_info`, `list_procedures`, `find_patient`, `register_patient`, `find_appointment_slots`, `book_appointment`, `get_my_appointments`, `cancel_appointment`. Slots are real: opening hours, closed days, which clinician does that treatment, minus what is already booked, re-checked at write time so two callers cannot take the same minute. `find_patient` surfaces medical flags (allergies, anticoagulants) so the voice says them before booking.

**After hours** — `get_aftercare` reads the clinic's protocol for a treatment; `check_symptom` triages what the patient says into `expected`, `call_clinic` or `urgent`; `request_callback` logs a callback with urgency.

Every tool returns a `speech` field: one line already phrased for the ear, alongside the structured data. The server's instructions tell the host to read `speech` verbatim and never paraphrase clinical text.

### Safety — the part that actually mattered
`check_symptom` does not diagnose. It matches what the patient said against the red flags the clinic itself wrote down, under three rules:

1. **Concepts, not phrasings.** "Can't swallow", "trouble swallowing" and "swallowing hurts so much I stopped" are one emergency. Urgency comes from concepts that co-occur — an airway word near a difficulty word, a spread site (neck, throat, eye) near a swelling word.
2. **Unrecognised escalates.** Anything the rules cannot place goes to `call_clinic`. Silence is never "fine".
3. **A hard reassurance ceiling.** Even after a normal-recovery match, the result is re-checked against the urgent concepts, and anything getting worse can never come back as `expected`.

The first version shipped a real bug: *"I'm having trouble swallowing and my neck is swelling"* returned **expected**. That is a spreading infection heading for the airway, and the server told the patient nothing was wrong. It is now test 1 of 36. The asymmetry is deliberate and written in the test file: this server may under-reassure; it may never over-reassure.

### How I built it
- TypeScript, `@modelcontextprotocol/sdk`, zod schemas, and MCP tool annotations (`readOnlyHint` everywhere, `destructiveHint` on cancel).
- One host-agnostic tool module (`src/tools.ts`) with two thin transports: Cloudflare Workers with a Durable Object per session, and a stateless Vercel function (no session id, a fresh server per request, JSON rather than an open SSE stream).
- Supabase Postgres over PostgREST: patients, providers, procedures, appointments, aftercare protocols, callbacks. Aftercare text lives in the database, because it is clinical content a practice must be able to amend without a deploy.
- A simulated Alexa+ front end (`/voice.html`): browser speech in and out plus a small intent router. Every reply is a live `tools/call` to `/mcp`, and the call is printed under each turn so it is always clear which part is the voice shell and which is the server.
- A post-deploy smoke test that does a real `initialize` → `tools/list` → `tools/call` and asserts all three dispositions — added after a deployment silently lost its secrets and still returned 200 on `/health`.

### Challenges
- Getting triage to fail safe. Literal-phrase matching looked fine in a demo and was dangerous in practice; the rewrite to concept co-occurrence plus a reassurance ceiling is what makes this deployable.
- Two Vercel runtime traps: ESM needs `"type": "module"` plus explicit `.js` import extensions, and a default-exported `(Request) => Response` is invoked as Node `(req, res)` and hangs — the handlers are exported as `GET`/`POST`/`DELETE`.

### Accomplishments
- A voice triage path that escalates every phrasing of the airway emergency we could think of, with the original failing case kept as the first regression test.
- A booking flow that reads a patient's penicillin allergy back before confirming — the kind of detail that matters at a real front desk.
- Aftercare protocols written by a clinician, not generated.

### What I learned
In a voice channel the output format is the product. Returning a sentence meant for the ear, and instructing the host to read it verbatim, removed a whole class of failure where a model paraphrases clinical advice into something subtly different.

### What's next
- Put the clinic's identity provider in front of `/mcp` and scope every tool to the calling patient (the tool surface already keys off phone number rather than free-text identity).
- A per-clinic timezone and Arabic speech, for the clinics I actually work with.
- Recall reminders and post-op check-in calls the day after an extraction.

## Built with
typescript, model-context-protocol, mcp, cloudflare-workers, durable-objects, vercel, supabase, postgresql, zod, vitest, web-speech-api

## Try it out
- Live server page with an in-browser triage panel: https://clinicdesk-mcp.vercel.app
- Simulated Alexa+ voice front end: https://clinicdesk-mcp.vercel.app/voice.html
- MCP endpoint: https://clinicdesk-mcp.vercel.app/mcp
- Code (MIT): https://github.com/Y385471/clinicdesk-mcp

## Track
Alexa+ — self-hosted MCP server on spec 2025-11-25 over Streamable HTTP, with a simulated Alexa+ voice front end.

## New during the submission period
Built from scratch between 22 and 23 September 2026, inside the submission period.
