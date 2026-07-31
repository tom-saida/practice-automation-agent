# Practice Front-Office Agent

An SMS-first AI agent for medical/dental front offices, built in n8n — **live-tested end to end**, designed around the constraint most agent demos ignore: healthcare, where the AI must be useful *and* provably controlled.

Built and operated by [Tom Martorana / SAIDA](mailto:tom@saida.us). Companion repo: [n8n-hipaa-stack](../n8n-hipaa-stack) — the HIPAA-eligible self-hosted infrastructure this deploys onto.

> All data in this repo is **synthetic**. "Harborline Orthodontics" is a fictional demo practice. No PHI, no real patients, no real practice.

## What it does

One phone number, two lanes, two temperaments:

**Patient lane — a deterministic state machine.** A missed call fires a webhook → the caller gets a template text-back in under 60 seconds → an LLM classifies the reply (new patient / existing / question, with an "unsure" fallback) → new patients get offered *real* open slots → "reply 1 or 2" books the consult and flips the slot → everything else lands in a human callback queue with full context. STOP/opt-out is handled **rule-based, before any AI sees the text**. Patients only ever receive pre-approved templates — the AI classifies and routes; it never freelances with a patient.

**Admin lane — the powerful agent.** The practice owner texts the same number from an allowlisted phone:
- *"who's waiting on a callback and what's booked Monday?"* → the workflow assembles the entire practice state (facts, queue, conversations, last 30 events, slots) into context and answers SMS-length, grounded, with per-admin conversation memory
- *"text +1555...: does Thursday still work?"* → relays a message to a patient through the same send gate, logged

**Owner digest.** Daily 7 AM email: missed calls caught, consults booked, handed to front desk — pulled from the event log, no dashboards.

Real test transcript (local model, synthetic data):

> **Owner:** what insurance do we accept and what are our friday hours? also how much is invisalign?
> **Agent:** We accept Delta Dental PPO, MetLife, Cigna DPPO, Aetna, United Concordia, and Humana. Friday hours are 7:40 AM - 1:00 PM. Invisalign is $5,200 - $6,800 depending on case.

Every fact in that answer traces to a table row. Ask it something the data can't answer and it says so instead of guessing.

## Design principles

1. **Deterministic where it faces patients, agentic where it faces trusted staff.** The compliance story and the capability story are separate lanes, not a compromise.
2. **A send gate on every outbound message.** Ships in `simulate` mode — messages log instead of sending — so the whole system is testable with `curl` and nothing escapes until a human flips it.
3. **Event-sourced audit log.** Every action writes to `ortho_events`: what ran, when, for whom. The daily digest and the admin brain both read from it.
4. **Human fallback everywhere.** Model down? Classification unsure? Reply ambiguous? → callback queue. A human always catches what AI drops.
5. **Model-agnostic.** Runs on a local model via LM Studio (how it was tested) or any OpenAI-compatible endpoint; production healthcare deployments point at a BAA-covered provider (e.g., AWS Bedrock) per the companion infra repo.
6. **Context-stuffing over RAG** for operational state: the practice's live state is small enough to hand the model whole, deterministically — retrieval can't miss what you never search for. (RAG belongs in the SOP/knowledge module, not the state brain.)

## Repo map

```
workflow/practice-front-office-agent.json   the n8n workflow (import this)
scripts/setup-instance.mjs                  create + seed the six data tables on a fresh instance
demo/flow-demo.html                         interactive flow visualization (open in a browser)
seed/practice_facts.json                    fictional practice config (insurance, hours, fees, policies)
seed/slots.json                             demo consult slots
seed/admins.json                            allowlisted admin/owner number(s) for the admin lane
docs/voice-roadmap.md                       the voice layer design (STT/LLM/TTS)
```

## Run it

1. n8n 1.x (self-hosted or cloud — for anything real, self-hosted per [n8n-hipaa-stack](../n8n-hipaa-stack)).
2. Create six **data tables** — instance-level, *not* part of the workflow import (the workflow's Data Table nodes reference them by name, so matching names is all the wiring the import needs). Fastest is the setup script, which creates all six and seeds the three static ones in one shot:
   ```bash
   # Node 18+. API key from the target instance: Settings → n8n API → Create API key.
   N8N_URL=https://YOUR-N8N N8N_API_KEY=xxxxx node scripts/setup-instance.mjs
   # add --with-workflow to also import the workflow JSON in the same run
   ```
   To create them by hand instead (n8n auto-adds id/createdAt/updatedAt):
   - `ortho_conversations` (phone, state, patient_type, last_message, offered_slots, updated_at — all string)
   - `ortho_slots` (slot_label string, taken boolean, booked_by, booked_at string)
   - `ortho_queue` (phone, reason, context, status, created_at — string)
   - `ortho_events` (event, phone, detail, at — string)
   - `ortho_admins` (phone, name, role — string)
   - `ortho_practice_facts` (category, key, value — string)
3. Seed `ortho_practice_facts`, `ortho_slots`, and `ortho_admins` from `seed/` (the setup script already did this — skip if you used it).
4. Import the workflow JSON (skip if you used `--with-workflow`), attach your credentials (any OpenAI-compatible model, Twilio, Gmail), publish.
5. Test with curl — safe, the send gate ships in simulate mode:
   ```bash
   # a missed call
   curl -X POST https://YOUR-N8N/webhook/ortho-missed-call \
     -H 'Content-Type: application/json' \
     -d '{"caller":"+15555550142","call_id":"CA-TEST-1"}'
   # the caller replies
   curl -X POST https://YOUR-N8N/webhook/ortho-inbound-sms \
     -H 'Content-Type: application/json' \
     -d '{"From":"+15555550142","Body":"Hi - looking for a braces consult for my daughter"}'
   # the caller books
   curl -X POST https://YOUR-N8N/webhook/ortho-inbound-sms \
     -H 'Content-Type: application/json' -d '{"From":"+15555550142","Body":"1"}'
   # the owner asks the brain (use the number you put in ortho_admins)
   curl -X POST https://YOUR-N8N/webhook/ortho-inbound-sms \
     -H 'Content-Type: application/json' \
     -d '{"From":"+15555550100","Body":"who is in the callback queue?"}'
   ```
6. Watch state move through `ortho_conversations` (texted → offered → booked) and the audit trail accrue in `ortho_events`.

**Production hardening before anything real:** webhook signature validation, admin PIN step-up, BAAs, and the rest — see [n8n-hipaa-stack/hardening.md](../n8n-hipaa-stack/hardening.md).

## Status

113 nodes, all lanes live-tested. Core lifecycle (missed call → text-back → AI triage → slot offer → booking → STOP compliance; admin QA + relay; existing-patient/question lanes; scheduled digest verified in production). **Race-tested:** two patients offered the same slot both replying "1" — the loser is detected (`taken=false` guard) and gracefully re-offered live availability; the re-offered patient then booked from the fresh offer in the same test run. Also shipped and tested: **appointment reminders** (hourly sweep parses slot labels to datetimes; 24h + 2h reminders, event-log dedup — zero schema changes), **no-reply nudges** (4h follow-up, 24h expire-to-queue), **reschedule/cancel intents** (finds the booking, frees the slot back into the pool, re-offers), **FAQ auto-answers** (template answers assembled from the practice-facts table — hours, insurance, fees — still Tier-0 safe), **MMS photo lane** (queued for doctor review with ack), **new-patient forms rail** (booking confirm carries the form link, completion webhook closes the loop, sweep chases incompletes), and a **payment-reconciliation webhook** (processor callback → event log → receipt text; card data never touches the stack). Three bugs were found by live testing and fixed in this repo's history — see the commits.

Roadmap: admin PIN step-up, queue-close commands, and the voice front door (`docs/voice-roadmap.md`). Roadmap: reschedule/cancel intents, urgent-triage lane with photo capture, recall sweeps, payment links, and the voice front door (see `docs/voice-roadmap.md`).

MIT licensed. Built with n8n's workflow SDK, driven by an AI-assisted development loop — every path in this repo was exercised against a live instance before it shipped.
