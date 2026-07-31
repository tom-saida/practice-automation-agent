#!/usr/bin/env node
// setup-instance.mjs — provision the practice agent's data tables on a fresh n8n instance.
//
// This is the "rep that matters" from the deploy runbook, scripted: the six data tables
// are instance-level (they do NOT travel inside the workflow export), so a fresh instance
// needs them created + the three static ones seeded before the imported workflow will run.
// The workflow's Data Table nodes reference tables by NAME, so creating these six names is
// all the wiring the import needs.
//
// Usage:
//   N8N_URL=https://ortho-test.example.com \
//   N8N_API_KEY=xxxxx \
//   node scripts/setup-instance.mjs [--force-seed] [--with-workflow]
//
//   --force-seed     re-insert seed rows even into tables that already existed (may duplicate)
//   --with-workflow  also import workflow/practice-front-office-agent.json (created inactive,
//                    credentials + model swap still done by hand afterward)
//
// Env:
//   N8N_URL           base URL of the target instance (required), e.g. https://ortho-test.example.com
//   N8N_API_KEY       a public-API key (Settings → n8n API → Create API key) (required)
//   SEED_ADMIN_PHONE  E.164 number seeded into ortho_admins (default +15555550100, the README demo owner)
//   SEED_ADMIN_NAME   display name for that admin (default "Practice Owner (demo)")
//
// No dependencies. Requires Node 18+ (global fetch). Idempotent: existing tables are left
// alone and not re-seeded unless --force-seed.

import { readFileSync } from "node:fs";

const API_KEY = process.env.N8N_API_KEY;
const RAW_URL = process.env.N8N_URL;
const FORCE_SEED = process.argv.includes("--force-seed");
const WITH_WORKFLOW = process.argv.includes("--with-workflow");

if (!RAW_URL || !API_KEY) {
  console.error("ERROR: set N8N_URL and N8N_API_KEY.\n" +
    "  N8N_URL=https://your-instance N8N_API_KEY=xxxxx node scripts/setup-instance.mjs");
  process.exit(1);
}
if (typeof fetch !== "function") {
  console.error("ERROR: global fetch missing — run with Node 18 or newer.");
  process.exit(1);
}

const BASE = RAW_URL.replace(/\/+$/, "");           // strip trailing slash(es)
const seedPath = (f) => new URL(`../seed/${f}`, import.meta.url);
const readSeed = (f) => JSON.parse(readFileSync(seedPath(f), "utf8"));

// --- table definitions: columns + order + types must match the live schema exactly ---
// n8n auto-adds id/createdAt/updatedAt system columns; only the user columns are declared.
const S = "string", B = "boolean";
const TABLES = [
  { name: "ortho_conversations", seed: null,
    columns: col([["phone", S], ["state", S], ["patient_type", S], ["last_message", S], ["offered_slots", S], ["updated_at", S]]) },
  { name: "ortho_slots", seed: "slots.json",
    columns: col([["slot_label", S], ["taken", B], ["booked_by", S], ["booked_at", S]]) },
  { name: "ortho_queue", seed: null,
    columns: col([["phone", S], ["reason", S], ["context", S], ["status", S], ["created_at", S]]) },
  { name: "ortho_events", seed: null,
    columns: col([["event", S], ["phone", S], ["detail", S], ["at", S]]) },
  { name: "ortho_admins", seed: "admins.json",
    columns: col([["phone", S], ["name", S], ["role", S]]) },
  { name: "ortho_practice_facts", seed: "practice_facts.json",
    columns: col([["category", S], ["key", S], ["value", S]]) },
];
function col(pairs) { return pairs.map(([name, type]) => ({ name, type })); }

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { "X-N8N-API-KEY": API_KEY, "Content-Type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${res.statusText}\n${text.slice(0, 800)}`);
  }
  return json;
}

// GET all existing data tables (paginated) → Map(name → id)
async function existingTables() {
  const byName = new Map();
  let cursor = "";
  do {
    const qs = `?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await api("GET", `/data-tables${qs}`);
    for (const t of page.data ?? []) byName.set(t.name, t.id);
    cursor = page.nextCursor ?? "";
  } while (cursor);
  return byName;
}

function adminSeed() {
  // Precedence: SEED_ADMIN_PHONE env (an operator seeding a real owner without editing the
  // repo) > seed/admins.json (repo default: the demo owner) > synthetic fallback.
  if (process.env.SEED_ADMIN_PHONE) {
    console.log(`  · ortho_admins from SEED_ADMIN_PHONE env (${process.env.SEED_ADMIN_PHONE})`);
    return [{
      phone: process.env.SEED_ADMIN_PHONE,
      name: process.env.SEED_ADMIN_NAME || "Practice Owner",
      role: "owner",
    }];
  }
  try {
    return readSeed("admins.json");
  } catch {
    return [{ phone: "+15555550100", name: "Practice Owner (demo)", role: "owner" }];
  }
}

async function main() {
  console.log(`→ target: ${BASE}`);
  const existing = await existingTables();

  const createdNames = new Set();
  const idByName = new Map(existing);

  for (const t of TABLES) {
    if (existing.has(t.name)) {
      console.log(`  = ${t.name} (already exists, id ${existing.get(t.name)}) — skipped`);
      continue;
    }
    const created = await api("POST", "/data-tables", { name: t.name, columns: t.columns });
    idByName.set(t.name, created.id);
    createdNames.add(t.name);
    console.log(`  + ${t.name} (created, id ${created.id})`);
  }

  // Seed the three static tables. Only tables we just created are seeded,
  // unless --force-seed is passed (which may duplicate rows).
  for (const t of TABLES) {
    if (!t.seed) continue;
    const shouldSeed = createdNames.has(t.name) || FORCE_SEED;
    if (!shouldSeed) {
      console.log(`  · ${t.name} pre-existed — not re-seeded (use --force-seed to override)`);
      continue;
    }
    const rows = t.name === "ortho_admins" ? adminSeed() : readSeed(t.seed);
    if (!rows.length) { console.log(`  · ${t.name} seed empty — nothing to insert`); continue; }
    const id = idByName.get(t.name);
    const out = await api("POST", `/data-tables/${id}/rows`, { data: rows });
    const n = typeof out?.count === "number" ? out.count : rows.length;
    console.log(`  ↳ ${t.name}: seeded ${n} row(s)`);
  }

  if (WITH_WORKFLOW) {
    const wf = JSON.parse(readFileSync(new URL("../workflow/practice-front-office-agent.json", import.meta.url), "utf8"));
    const payload = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings ?? {} };
    const created = await api("POST", "/workflows", payload);
    console.log(`  + workflow imported: "${created.name}" (id ${created.id}) — inactive`);
  }

  console.log("\n✓ tables ready. Next steps (by hand — secrets never travel in exports):");
  console.log("  1. Import workflow/practice-front-office-agent.json (skip if you used --with-workflow).");
  console.log("  2. Attach credentials on the new instance: model (Bedrock/Anthropic/OpenAI-compatible), Twilio, Gmail.");
  console.log("  3. Swap the two model sub-nodes to your BAA-covered provider (see n8n-hipaa-stack/bedrock-swap.md).");
  console.log("  4. Activate, then curl the webhooks (simulate mode is on — nothing sends). See README 'Run it'.");
}

main().catch((e) => { console.error("\n✗ setup failed:\n" + e.message); process.exit(1); });
