// Seeds one realistic, messy, multi-file coding session so model benchmarks
// run against a prompt the size summarize() actually sees in practice.
const BASE = "http://localhost:3111";
const PROJECT = "/tmp/agentmemory-largebench";
const SESSION = "largebench_001";

type Obs = { toolName: string; toolInput: Record<string, string>; toolOutput: string };

const OBS: Obs[] = [
  { toolName: "Read", toolInput: { file_path: "src/billing/subscription.ts" }, toolOutput: "Read 412 lines. Subscription state machine with 6 states; renewal logic inline in updateSubscription()." },
  { toolName: "Grep", toolInput: { pattern: "stripe.subscriptions.update" }, toolOutput: "7 matches across src/billing/subscription.ts, src/billing/webhook.ts, src/admin/override.ts." },
  { toolName: "Edit", toolInput: { file_path: "src/billing/subscription.ts" }, toolOutput: "Extracted renewal logic into renewSubscription(). Kept updateSubscription() as a thin wrapper so the 7 existing call sites keep working." },
  { toolName: "Write", toolInput: { file_path: "src/billing/proration.ts" }, toolOutput: "New module. Computes prorated credit on mid-cycle plan changes. Uses integer cents throughout — floats were producing off-by-one-cent invoices." },
  { toolName: "Bash", toolInput: { command: "npm test -- billing" }, toolOutput: "14 passed, 3 failed. Failures all in proration: expected 1667 got 1666." },
  { toolName: "Edit", toolInput: { file_path: "src/billing/proration.ts" }, toolOutput: "Switched from Math.round to banker's rounding to match Stripe's documented behaviour. All 17 billing tests pass." },
  { toolName: "Read", toolInput: { file_path: "src/billing/webhook.ts" }, toolOutput: "Webhook handler processes 11 Stripe event types. No idempotency key check — duplicate deliveries would double-apply credits." },
  { toolName: "Write", toolInput: { file_path: "src/billing/idempotency.ts" }, toolOutput: "Added Redis-backed idempotency guard keyed on Stripe event id, 24h TTL. Chose Redis over Postgres to avoid a write on every webhook." },
  { toolName: "Edit", toolInput: { file_path: "src/billing/webhook.ts" }, toolOutput: "Wrapped all 11 handlers in withIdempotency(). Replays now return 200 without re-applying." },
  { toolName: "Bash", toolInput: { command: "npm test -- webhook" }, toolOutput: "22 passed. Added replay test that fires the same event id twice." },
  { toolName: "Read", toolInput: { file_path: "migrations/V212__invoice_lines.sql" }, toolOutput: "Existing migration adds invoice_lines. No index on (invoice_id, created_at)." },
  { toolName: "Write", toolInput: { file_path: "migrations/V213__invoice_lines_index.sql" }, toolOutput: "Added composite index on (invoice_id, created_at desc). Invoice detail query dropped from 840ms to 12ms on the 2.1M row table." },
  { toolName: "Bash", toolInput: { command: "npx flyway migrate" }, toolOutput: "Successfully applied 1 migration to schema public, now at version V213." },
  { toolName: "Edit", toolInput: { file_path: "src/admin/override.ts" }, toolOutput: "Admin manual-credit path bypassed proration entirely. Routed it through renewSubscription() so admin and automated paths share one code path." },
  { toolName: "Grep", toolInput: { pattern: "TODO.*billing" }, toolOutput: "3 matches. Two stale (resolved by this work), one real: refunds don't reverse proration credits." },
  { toolName: "Write", toolInput: { file_path: "test/proration-property.test.ts" }, toolOutput: "Property test: for any plan change, credit + charge must equal the difference in plan price. 1000 generated cases, all pass." },
  { toolName: "Bash", toolInput: { command: "npm run typecheck" }, toolOutput: "2 errors in src/admin/override.ts: Argument of type 'string' not assignable to 'PlanId'." },
  { toolName: "Edit", toolInput: { file_path: "src/admin/override.ts" }, toolOutput: "Narrowed the admin plan input with a PlanId parse at the boundary instead of casting. Typecheck clean." },
  { toolName: "Read", toolInput: { file_path: "docs/billing.md" }, toolOutput: "Docs describe the old inline renewal flow and make no mention of proration." },
  { toolName: "Edit", toolInput: { file_path: "docs/billing.md" }, toolOutput: "Rewrote the renewal section, documented banker's rounding and the idempotency guarantee." },
  { toolName: "Bash", toolInput: { command: "npm test" }, toolOutput: "Full suite: 486 passed, 0 failed, 11.4s." },
  { toolName: "Bash", toolInput: { command: "git commit -m 'refactor(billing): extract renewal, add proration + webhook idempotency'" }, toolOutput: "8 files changed, 412 insertions(+), 96 deletions(-)." },
];

async function main() {
  await fetch(`${BASE}/agentmemory/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: SESSION, project: PROJECT, cwd: PROJECT }),
  });

  let stored = 0;
  for (const obs of OBS) {
    const res = await fetch(`${BASE}/agentmemory/observe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hookType: "post_tool_use",
        sessionId: SESSION,
        project: PROJECT,
        cwd: PROJECT,
        timestamp: new Date().toISOString(),
        data: { tool_name: obs.toolName, tool_input: obs.toolInput, tool_output: obs.toolOutput },
      }),
    });
    if (res.ok) stored++;
    else console.log(`  failed: ${obs.toolName} ${res.status}`);
  }
  console.log(`seeded ${stored}/${OBS.length} observations into ${SESSION}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
