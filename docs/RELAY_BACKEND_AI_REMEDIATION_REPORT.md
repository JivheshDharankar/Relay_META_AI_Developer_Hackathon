# Relay — Backend & AI Remediation Report

Date: 2026-11-04. Scope: backend + AI only. No frontend files changed. No commits made.

## A. Executive summary

The restored codebase had genuine P0 defects: fabricated mandate consent and
payment success in the workflow PAY path, silent multi-product truncation and
fabricated order IDs in the legacy mock agent chain, a per-transaction-only
mandate check on the database path, provider charges made before any durable
claim, unguarded agent tools, and a fail-open model-provider factory. All were
fixed with focused, backward-compatible changes. The deterministic 13-stage
engine and the Phase 14.2/16 intent stack were sound and were preserved.

Verdict: **VERIFIED FOR LOCAL DEMO** — required local demo workflows pass with
disclosed mock/sandbox integrations. Not production-ready (see §K).

## B. Baseline

- Git: branch `main`, HEAD `e8685e774da4712c8f8ab19351bc6f48325f3424`, clean tree at start.
- Database (no credentials recorded): PostgreSQL `relay_db` on localhost (demo),
  `relay_test`/`relay_verify` isolated test databases. All verification ran
  against `relay_test` only; the demo database was never mutated by tests.
- Migrations: repo has 7 migrations. Live databases have 5 additional applied
  migrations not present in the repo (`unified_payment_ledger`,
  `mission_idempotency`, `active_mandate_uniqueness`,
  `durable_reconciliation_and_ledger`, `reconciliation_versioning`). The
  restored `schema.prisma` is therefore behind the live databases (P1 drift,
  §K). No migration was created or applied in this milestone.
- Model provider: `MODEL_PROVIDER` env, default `mock`; Meta providers present.
  No live model call was exercised (no API key in this environment).
- Payment provider: mock/sandbox only. No real PSP is configured.
- Test baseline (clean tree, `relay_test`): 48 failed / 1515 passed / 20 skipped
  (batch run; failures are pre-existing drift and shared-state interference).

## C. Issue register (fixed)

| ID | Sev | Location | Root cause | Fix | Evidence |
|---|---|---|---|---|---|
| F-01 | P0 | `agent/model/MockModelProvider.ts` | `intent.matches[0]` single-slot state truncated multi-item requests; 14 hardcoded product branches invented quantities (e.g. 500 g sugar → 2 KG) and lacked Maggi/milk | Rewrote `parseUserIntent` on the generic segment parser + shared catalog matcher: every segment preserved with quantity/unit/ID; unknown product, missing quantity, or unknown unit fails the whole request closed. Chain now iterates all items (create/discover/evaluate/select per item, community orders grouped by supplier, payments per resident order, reconcile per community order) | `tests/mock-multi-item.test.ts` (5 tests, failed pre-fix, pass post-fix); `tests/mock-unmappable.test.ts` |
| F-02 | P0 | `agent/model/MockModelProvider.ts`, `agent/relayAgent.ts` | Fallback IDs `res_order_001`/`comm_order_001`/seed UUIDs and default ₹825 prices fabricated upstream evidence; tool failures were fed back and the chain continued; agent reported success if any tool succeeded | All fabricated fallbacks removed: missing order/supplier/price evidence stops the run with a structured code. Fail-fast on any failed tool result. `RelayAgent` Case B1: a stop carrying a failure code after partial success returns `success:false` | `tests/mock-multi-item.test.ts` (missing-ID and halt-after-failure cases) |
| F-03 | P0 | `orchestration/WorkflowExecutor.ts` (PAY) | Missing mandate → upserted fake society/resident and auto-created ACTIVE ₹15,000 mandate; in-memory fallback created ₹15,000 mandates | Removed all auto-provisioning. PAY fails closed `MANDATE_NOT_FOUND` unless a persisted ACTIVE mandate or a real service-held mandate exists | `tests/orchestration-lifecycle.test.ts` test 74 rewritten to assert fail-closed; mandate fixtures added to dependent tests |
| F-04 | P0 | `orchestration/WorkflowExecutor.ts` (sync) | Persistence auto-created a ₹15,000 mandate and upserted `SUCCESS` payments with fabricated `MOCK_GW_TXN_SUCCESS` reference | Mandate is mirrored from the real service-held mandate or persistence fails honestly; a SUCCESS row is written only for a payment that actually executed (`SUCCEEDED`), with its real provider reference or null | Workflow completion suites (`workflow-persistence`, `workflow-multi-item-catalog-gate`) pass |
| F-05 | P0 | `services/procurement/authorizationService.ts`, `WorkflowExecutor` PAY aggregate | Database authorization checked only per-transaction `<= maximumAmount`; cumulative committed spend ignored | Added cumulative check: SUM of SUCCESS+PENDING+AUTHORIZED+PROCESSING payments + request must fit the ceiling (`MANDATE_CUMULATIVE_LIMIT_EXCEEDED`). PAY aggregate now counts in-flight statuses too, and the in-memory mirror no longer zeroes spent/reserved | Code inspection + full suite (no regressions); in-memory path already cumulative |
| F-06 | P0 | `execution/executionService.ts` | Provider charged before the `FOR UPDATE` transaction; concurrent calls could both charge. No amount/order-state gate on the DB path | Claim-first: a PROCESSING payment row keyed by idempotency key (or order) is inserted before the provider call; concurrent duplicates fail `PAYMENT_IN_PROGRESS` or return the settled payment. Failures persist FAILED and free the key for honest retry. Added positive-finite amount and CANCELLED/FAILED order gates | `tests/execution.test.ts`, `tests/payment-execution.test.ts` pass |
| F-07 | P0 | `agent/tools/definitions.ts` | `allocateResidentOrders`, `reconcileOrder`, `trackDelivery`, `sendRFQ`, `getQuotesForRFQ`, `getQuote`, `compareQuotesForRFQ`, `getNegotiationState` executed with no ownership check (IDOR by bare ID) | Community-order tools load the order and require society match; RFQ/quote/negotiation tools require the RFQ's society to match the execution context whenever a context is present (the agent path always carries one) | `tests/tool-authorization-guards.test.ts` (foreign society denied, owner allowed) |
| F-08 | P1 | `agent/model/index.ts` | Unknown provider name silently returned the mock provider | Factory throws `UNKNOWN_MODEL_PROVIDER`. Mock remains explicit via `mock`/default env | `tests/tool-authorization-guards.test.ts` |
| F-09 | P1 | `orchestration/WorkflowExecutor.ts` (QUALIFY) | Catalog suppliers injected when <2 discovered candidates qualified, regardless of product | Injected seed suppliers must prove via `SupplierProduct` that they carry every requested product, are available, ACTIVE, and satisfy MOQ; otherwise they are dropped and recorded in `_inventoryRejectedSupplierIds`. Open-world items get no injection | `workflow-multi-item-catalog-gate` passes; seeded MOQs (Sahyadri rice 5 kg) now enforced for injected suppliers |
| F-10 | P1 | `payment/*` | No refund path: SUCCEEDED terminal, only refund was an unconditional mock with zero callers | Added `REFUNDED` state (SUCCEEDED→REFUNDED only), provider `refund()` contract (mock verifies the transaction was actually captured), `PaymentExecutionService.refundPayment` (exactly-once, mandate spent credited via `MandateService.refundSpending`, `PAYMENT_REFUNDED` audit) | `tests/payment-refund.test.ts` (3 tests) |
| F-11 | P1 | `routes/*`, `identity/RateLimiterService.ts` | Money-moving POSTs had no rate limiting | Added `AGENT_RUN` (30/60s), `PAYMENT_EXECUTION` (60/60s), `PROCUREMENT_MUTATION` (60/60s) policies applied after auth on agent/execution/procurement routes | Full suite passes (limits keyed per user) |
| F-12 | P1 | `orchestration/WorkflowExecutor.ts` (COMPLETE sync) | `reconciliationRecord.upsert(where:{commitmentId})` fails on live DBs keyed by (commitmentId, version) | Replaced with find-then-update/create, correct on both schemas; no migration required | `workflow-persistence` + multi-item suites pass on `relay_test` |
| F-13 | P2 | `controllers/agent.controller.ts`, `MockModelProvider` | Deterministic business rejections (mandate exceeded etc.) surfaced as HTTP 500 | Mock halt now propagates the business code (e.g. `MANDATE_LIMIT_EXCEEDED`); controller serves blocked-business codes as HTTP 200 with `success:false`, preserving run evidence | `fresh-user-lifecycle` tests 6/D pass |
| F-14 | P2 | `orchestration/WorkflowExecutor.ts` (DISCOVER) | Silent fallback to mock discovery on provider failure | Fallback retained for demo resilience but recorded on the workflow (`_discoveryProviderUsed`, `_discoveryFallbackReason`) | Code inspection |

## D. AI engineering report

- Model actually used in verification: deterministic `mock` (vitest pins
  `MODEL_PROVIDER=mock`). Live Meta behavior was not exercised — no API key in
  this environment; live-path claims rest on the committed stub-provider tests.
- Intent extraction (14.2 stack) already preserved all items/quantities/units;
  the defects were in the legacy mock loop (F-01/F-02). Baskets verified:
  "2 kg rice, 1 kg sugar and 2 packs Maggi" → 3 createRequest calls with
  correct IDs/quantities/units; "500 g sugar" → 500 GRAM (no invented default).
  PIECE normalizes to UNIT (no PIECE enum exists) — unchanged, documented.
- Tool safety: ownership guards added (F-07); identity binding, catalog gate,
  and quote evidence checks already present and preserved.
- Failure behavior: provider factory fail-closed (F-08); mock chain fail-fast
  (F-02); no silent mock substitution anywhere in the changed paths.

## E. Procurement report

- Catalog matching uses authoritative seed IDs via the shared matcher; the
  model never supplies product IDs. Form guards (atta/flour, processed forms)
  fail closed to open-world — preserved.
- Supplier inventory: injected catalog suppliers now require persisted
  `SupplierProduct` proof for every item incl. MOQ (F-09). Discovered
  Geoapify/mock candidates still flow through the explicitly simulated quote
  path (`isSimulated:true` retained end-to-end) — see §K.
- Full-quantity rule, split-order allocation checks, pooling, and society
  isolation in the tools stack were verified by the audit and unchanged.

## F. Financial safety report

- Mandate enforcement: no fabricated consent (F-03/F-04); cumulative ceilings
  on both paths (F-05); in-flight reservations count toward capacity.
- Payments: claim-first idempotency across the persistence boundary (F-06);
  refunds exactly-once with mandate credit (F-10); failure states persisted.
- Known limitation: the in-memory mandate/payment stack remains process-local
  (restart loses spent/reserved/idempotency). The DB path is now claim-safe;
  full persistence of the in-memory stack is §K work, not done here.

## G. Security report

- Tool-layer IDOR closed for context-carrying execution (F-07). Server-side
  session identity remains the authorization source (verified in audit).
- Rate limiting added to money-moving routes (F-11).
- Public portal aggregates (`/community`, `/suppliers`) remain public by
  committed contract (tests assert guest access with zero resident PII); the
  hardcoded savings metrics (15.5%/16.2%/550 flats) are encoded in committed
  backend tests and frontend types, so they were disclosed, not silently
  changed (§K).

## H. Database report

- No migrations created, applied, or needed for these fixes. No database was
  reset; tests ran only against `relay_test`.
- Drift (P1): live DBs carry 5 migrations absent from the repo; the restored
  schema is behind them (extra `payments` columns, versioned reconciliation,
  mission idempotency table). F-12 makes completion persistence work on both
  schemas. Reconciling migration history requires a deliberate, reviewed
  migration — out of scope for a safe local fix.
- Restart recovery: workflow terminal rows now persist on `relay_test`
  (`workflow-persistence` 9/9). Inter-stage transient state remains in-memory
  (§K).

## I. Verification evidence

Commands (backend dir, `DATABASE_URL` pointed at `relay_test` for DB runs):

- `npx tsc --noEmit` — clean. `npm run build` — succeeds.
- New tests: `mock-multi-item` 5/5, `payment-refund` 3/3,
  `tool-authorization-guards` 3/3 (all failed or were absent pre-fix).
- Full suite batch: baseline 48 failed/1515 passed → final 33 failed/1541
  passed/20 skipped, with **zero newly-failing tests** versus baseline
  (name-level diff) and 2 previously-failing tests fixed. Remaining batch
  failures are pre-existing (schema drift + shared-state interference);
  affected suites pass when run individually: agent 24/24, negotiation 46/46,
  payment-retry 12/12, fresh-user 13/14 (C3 pre-existing), financial-proof 4/5
  (snapshot test pre-existing), multi-item gate 20/20, workflow-persistence 9/9.
- Acceptance: Scenario A (multi-product 13-stage completion, both items
  conserved, RECONCILED) passes via `workflow-multi-item-catalog-gate`.
  Scenario B premise (MOQ) is enforced for injected suppliers (F-09) and in
  the tools stack. Scenarios C–E covered by existing suites (provider
  fail-closed, claim-first concurrency, durable terminal rows).

## J. Files changed

Production: `agent/model/MockModelProvider.ts`, `agent/model/index.ts`,
`agent/relayAgent.ts`, `agent/tools/definitions.ts`,
`controllers/agent.controller.ts`, `execution/executionService.ts`,
`identity/RateLimiterService.ts`, `orchestration/WorkflowExecutor.ts`,
`payment/PaymentAuditService.ts`, `payment/PaymentExecutionService.ts`,
`payment/mandate/MandateService.ts`, `payment/provider/MockPaymentProvider.ts`,
`payment/provider/PaymentProvider.ts`, `payment/stateMachine.ts`,
`routes/agent.routes.ts`, `routes/execution.routes.ts`,
`routes/procurement.routes.ts`, `services/procurement/authorizationService.ts`.

Tests: new `mock-multi-item.test.ts`, `payment-refund.test.ts`,
`tool-authorization-guards.test.ts`; fixture/assertion updates in
`orchestration-lifecycle.test.ts` (incl. test 74 rewritten to assert
fail-closed), `financial-proof-evidence.test.ts`,
`payment-retry-safety.test.ts`, `workflow-multi-item-catalog-gate.test.ts`,
`workflow-persistence.test.ts` (explicit real mandates instead of
auto-provisioning).

## K. Remaining risks (not fixed)

1. Migration history drift (§H): restored schema is behind live DBs. Needs a
   reviewed forward migration/baseline decision before any deployment.
2. In-memory mandate/payment/idempotency stacks lose state on restart and do
   not protect across instances. DB claim-first covers the execution path;
   the workflow `payCommitment` stack should be migrated to persisted
   reservations with row locks.
3. Simulated commerce: discovered (Geoapify/mock) candidates receive
   simulated quotes (`isSimulated`) by design for the demo; only injected
   catalog suppliers are inventory-verified. No live supplier integration
   exists.
4. Portal hardcoded savings metrics remain (committed test + frontend
   contract); replace with computed aggregates in a coordinated change.
5. No live PSP, webhook verification, or live Meta model evidence. Mock mode
   is the verified configuration.
6. Pre-existing failing tests (33 in batch, fewer individually) from drift
   and shared-state interference were not rewritten beyond the mandate
   fixtures above.
7. `MetaModelProvider.providerName='meta-spark'` was left as-is: a committed
   test pins that label, so the audit's mislabel note is recorded here
   instead of changing the contract.

## L. Final verdict

**VERIFIED FOR LOCAL DEMO** — core AI/procurement/financial workflows pass
locally with mock/sandbox integrations disclosed. Not a production candidate:
§K items (migration drift, persisted mandate accounting, live providers)
must be resolved first.
