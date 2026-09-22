# ClinicDesk MCP

**A self-hosted MCP server that lets Alexa+ run a dental clinic's front desk — and answer the 2am question a patient cannot type.**

Built for the Alexa+ track of the Amazon Developer Hackathon.
Streamable HTTP · MCP spec revision **2025-11-25** · 11 tools · deploys to Cloudflare Workers or Vercel.

---

## The problem this exists for

A patient who had a tooth out this morning wakes at 2am. The gauze is soaked, their cheek is swollen, and they do not know whether this is normal or an emergency. Their mouth hurts, their hands are occupied holding gauze, and the clinic closed at seven.

What they do instead is search, land on a forum, and either panic about nothing or ignore something that needed a hospital. Both happen constantly.

This is the case voice is genuinely better at than a screen — and it is a case where a general assistant guessing from its training data is exactly the wrong thing. **ClinicDesk makes the assistant read the clinic's own written protocol back, and nothing else.**

```
"Alexa, I had a tooth out yesterday and my cheek is swollen."
→ Swelling on day 1 after a tooth extraction is within what we expect,
  so nothing is going wrong. Keep going with the aftercare.

"Alexa, I'm having trouble swallowing and my neck is swelling."
→ That needs to be seen now, not tomorrow. Please call the emergency
  line on +20 100 555 0199 straight away, and if you are struggling to
  breathe or swallow, go to the nearest emergency department instead
  of waiting for a call back.
```

The second one is a spreading infection heading for the airway. Getting that answer wrong is the only failure in this project that can actually hurt someone, so most of the engineering went there — see [Safety](#safety-the-part-that-actually-mattered).

---

## Quick start

```bash
git clone <this repo> && cd clinicdesk-mcp
npm install

# point it at your clinic database
cp .dev.vars.example .dev.vars   # fill in SUPABASE_URL + SUPABASE_SERVICE_KEY
npm run db:setup                 # creates tables and seeds a demo clinic

npm run dev                      # → http://localhost:8787/mcp
npm test                         # 36 tests, including the triage safety battery
```

Deploy — it runs on either host, from the same source:

```bash
# Cloudflare Workers — one Durable Object per client, so sessions are stateful
npm run deploy
npm run secrets:push
npm run smoke -- https://clinicdesk-mcp.<account>.workers.dev/mcp

# Vercel — stateless function, static landing page
npx vercel login                 # once
npx vercel env add SUPABASE_URL production
npx vercel env add SUPABASE_SERVICE_KEY production
npx vercel deploy --prod
npm run smoke -- https://<project>.vercel.app/mcp
```

`src/tools.ts` holds all eleven tools and knows nothing about either host;
`src/index.ts` and `api/mcp.ts` are the two transports, about fifteen lines
apart. The Worker keeps a session per client in a Durable Object. The Vercel
function is stateless — `sessionIdGenerator: undefined`, a fresh server per
request, JSON responses rather than an open SSE stream, since a function is
billed for the time a stream stays open and no tool here pushes to the client.

The Vercel function can be run and smoke-tested locally without a login:

```bash
npm run dev:vercel               # compiles api/ and serves it on :8799
npm run smoke -- http://localhost:8799/api/mcp
```

Three routes:

| Route | What it serves |
| --- | --- |
| `/` | A page showing the server is live, with a panel that runs `check_symptom` against this deployment from the browser. An MCP URL pasted into a browser otherwise looks broken. |
| `/mcp` | The MCP endpoint. Connect any host here. |
| `/health` | Plain JSON heartbeat. |

**Run `npm run smoke` after every deploy.** It does a real `initialize` → `tools/list` → `tools/call` and asserts the three dispositions. A deployment that has lost its secrets still returns 200 on `/health` and still serves the landing page — every tool just fails inside its result. That happened here once, and a heartbeat check would not have caught it.

---

## The 11 tools

Every tool returns a **`speech`** field: one short line already phrased for the ear, plus the structured data alongside it. That is the central design decision of this server — the host is reading results out loud, and a JSON blob is unusable in that channel. The server's `instructions` tell the model to read `speech` verbatim and never paraphrase clinical text.

### Front desk

| Tool | What it does |
| --- | --- |
| `get_clinic_info` | Address, hours, closed days, clinic and emergency numbers. |
| `list_procedures` | Bookable treatments with appointment lengths, for mapping "my filling fell out" onto a procedure code. |
| `find_patient` | Look up by phone. Returns the patient id **and medical flags** — allergies, anticoagulants, diabetes. |
| `register_patient` | Create a record. Refuses to duplicate an existing phone number. |
| `find_appointment_slots` | Real free slots: opening hours, closed days, which clinician does that treatment, and what is already booked. |
| `book_appointment` | Books a slot, **re-checking it is still free at write time** so two callers cannot take the same minute. |
| `get_my_appointments` | Upcoming bookings by phone. |
| `cancel_appointment` | Cancels by id and frees the slot. Marked `destructiveHint`. |

### After hours

| Tool | What it does |
| --- | --- |
| `get_aftercare` | The clinic's own protocol for a treatment: steps in order, plus the warning signs it wants to hear about. |
| `check_symptom` | Triage: `expected` / `call_clinic` / `urgent`. Does not diagnose. |
| `request_callback` | Logs a callback for the team with an urgency level. |

---

## Safety: the part that actually mattered

`check_symptom` does **not** diagnose and does not reason freely about symptoms. It matches what the patient said against the red flags **the clinic itself wrote down** for that procedure, and returns one of three dispositions. The model is instructed to read the result verbatim.

Three rules hold the whole thing up:

**1. Concepts, not phrasings.** People do not speak in regex. "Can't swallow", "trouble swallowing", "hard to swallow" and "swallowing hurts so much I've stopped" are one emergency. Urgency is decided on concepts that co-occur — an airway word near a difficulty word, a spread site (neck, throat, eye, floor of mouth) near a swelling word — never on fixed strings.

**2. Unrecognised escalates.** Anything the rules cannot place goes to `call_clinic`. The server never reassures by default. Silence is not "fine".

**3. A hard reassurance ceiling.** Even after the normal-recovery list matches, the result is re-checked against the urgent concepts, and anything describing worsening can never come back as `expected`. There is exactly one way to reach a reassuring answer and it has three gates in front of it.

### A real bug, kept as the first test

The first version shipped this:

```
"I'm having trouble swallowing and my neck is swelling"  →  expected ❌
```

A spreading submandibular infection — the thing that closes an airway — told the patient nothing was wrong. The pattern only knew the literal phrase `can't swallow`, and the bare word `swelling` matched the normal-recovery list.

That case is now the first line of `test/triage.test.ts`, along with fifteen other phrasings of the same emergencies. The suite is 36 tests and runs in about a second. The asymmetry is deliberate and stated in the test file: **this server may under-reassure, it may never over-reassure.**

```bash
npm test
✓ urgent: I am having trouble swallowing and my neck is swelling
✓ urgent: my throat feels like it is closing
✓ urgent: the bleeding will not stop
✓ expected: my cheek is a bit swollen and it aches
✓ never reassures about something that is getting worse, even on day one
  36 passed
```

---

## How it is built

```
src/tools.ts    The 11 tools and their instructions — host-agnostic
src/clinic.ts   PostgREST client, slot generation, triage rules
src/index.ts    Cloudflare Workers transport (Durable Object per session)
api/mcp.ts      Vercel transport (stateless function)
public/         index.html — the page at /, live tool demo, no MCP client needed
test/           36 tests, mostly clinical safety
scripts/        db setup and seeding, secret push, local Vercel run, smoke test
```

- **Transport** — Streamable HTTP via `McpAgent` from `agents`, served at `/mcp`. `@modelcontextprotocol/sdk` negotiates **2025-11-25**, verified against a real client handshake, not assumed.
- **Data** — Supabase over PostgREST. Seven tables: patients, providers, procedures, appointments, aftercare protocols, callbacks, clinic info. Aftercare text lives in the database, not in the code, because it is clinical content a practice must be able to change without a deploy.
- **Scheduling** — slots are generated from opening hours minus closed days minus that clinician's existing bookings, on a fifteen-minute grid, never inside the next hour. Deliberately explainable; a receptionist can follow it.
- **Annotations** — every tool declares `readOnlyHint`; `cancel_appointment` declares `destructiveHint`. Hosts and reviewers can see the blast radius without reading the code.
- **Credentials** — the service key lives in Worker secrets and is never returned by a tool, logged, or written into a response.

The aftercare content is real clinical guidance, written by a practising dentist. That is the part a general model cannot improvise safely, and it is why the tool exists.

---

## What it is not

- Not a diagnostic tool. It routes; it does not decide what is wrong with you.
- No prescribing, no dose changes, no medication advice beyond reading back what the clinic wrote.
- No authentication on the MCP endpoint in this build — a production deployment would put the clinic's identity provider in front of `/mcp` and scope every tool to the calling patient. The tool surface was designed for that: everything patient-facing already keys off a phone number rather than trusting free-text identity.

---

## Licence

MIT. See `LICENSE`.
