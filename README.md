# Relay: Autonomous Community Procurement

> **“The model reasons. Deterministic code governs.”**

[![Meta Global AI Developer Hackathon](https://img.shields.io/badge/Meta%20AI-Global%20Developer%20Hackathon-0866FF?logo=meta&logoColor=white)](https://meta.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript: 5.x](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js: 14.2](https://img.shields.io/badge/Next.js-14.2-black?logo=next.js&logoColor=white)](https://nextjs.org/)
[![PostgreSQL: 15+](https://img.shields.io/badge/PostgreSQL-15%2B-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Prisma ORM: 5.22](https://img.shields.io/badge/Prisma-5.22-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io/)

Relay is an autonomous multi-agent procurement platform designed for residential apartment communities and housing societies. Built for the **Meta Global AI Developer Hackathon**, Relay combines the reasoning and tool-calling capabilities of **Meta's `muse-spark-1.3`** with deterministic financial, state-machine, and double-entry accounting controls.

Residents submit procurement needs in plain natural language (English, Hindi, or Hinglish). Relay autonomously extracts multi-item demands, pools society-wide orders to unlock wholesale volume pricing, discovers local suppliers, conducts multi-round commercial negotiations, and executes the entire lifecycle through delivery and 4-pillar reconciliation — all bounded by pre-authorized spending mandates.

---

## Architecture & System Overview

```mermaid
flowchart TD
    subgraph Client ["Client Layer"]
        User["Resident (Natural Language Request)"]
        Web["Next.js 14 Frontend (/app)"]
        User -->|English / Hindi / Hinglish| Web
    end

    subgraph Gateway ["API & Authentication Layer"]
        API["Express Gateway (/api)"]
        Auth["Session & Identity Service\n(Google OAuth / Email OTP / Phone OTP)"]
        Web -->|REST / SSE Streams| API
        API --> Auth
    end

    subgraph Agent ["Cognitive & Reasoning Layer (Meta AI)"]
        RelayAgent["RelayAgent (Bounded ReAct Loop)"]
        ModelProv["ModelProvider Abstraction"]
        MetaSpark["MetaModelProvider (muse-spark-1.3)\nhttps://api.meta.ai/v1"]
        SparkOpen["SparkOpenProvider (Open-Weight)\nspark-open-7b"]
        PriceDiscovery["RealtimePriceDiscoveryService\n(Meta Responses API + web_search)"]

        API -->|POST /api/agent/run| RelayAgent
        RelayAgent --> ModelProv
        ModelProv --> MetaSpark
        ModelProv --> SparkOpen
        RelayAgent -.->|Price Grounding| PriceDiscovery
    end

    subgraph Engine ["Deterministic State Machine (13 Stages)"]
        WF["RelayOrchestrator & WorkflowExecutor"]
        S1["01 UNDERSTAND"] --> S2["02 DISCOVER"]
        S2 --> S3["03 QUALIFY"]
        S3 --> S4["04 QUOTE"]
        S4 --> S5["05 NEGOTIATE"]
        S5 --> S6["06 SELECT"]
        S6 --> S7["07 COMMIT"]
        S7 --> S8["08 PAY"]
        S8 --> S9["09 FULFILL"]
        S9 --> S10["10 VERIFY"]
        S10 --> S11["11 ALLOCATE"]
        S11 --> S12["12 RECONCILE"]
        S12 --> S13["13 COMPLETE"]

        RelayAgent -->|Tool Calls: startWorkflow / executeStep| WF
        WF --> S1
    end

    subgraph Governance ["Deterministic Core & Invariants"]
        Mandates["Payment Mandate Enforcement\n(Cumulative Spending Limits)"]
        Normalizer["Universal Quantity Normalizer\n(Dimensional Weight/Volume/Count)"]
        Privacy["Privacy & Anonymization Boundary\n(Zero Resident PII to Suppliers)"]
        Recon["4-Pillar Reconciliation Engine\n(Quantity, Money, PO, Payment)"]
        Ledger["Double-Entry Resident Ledger"]

        S8 --> Mandates
        S1 & S4 --> Normalizer
        S2 & S7 --> Privacy
        S11 --> Ledger
        S12 --> Recon
    end

    subgraph Persistence ["Durable Persistence Layer"]
        DB[(PostgreSQL via Prisma ORM)]
        Audit["Immutable AuditEvent Ledger"]
        WF --> DB
        WF --> Audit
    end
```

---

## Key Capabilities

### 1. Governed Autonomy: "The Model Reasons. Code Governs."
Relay rejects the paradigm where an LLM is given direct, unconstrained access to databases or payment APIs. Instead:
- **Meta AI reasons and plans:** Identifies line items, resolves colloquial units, ranks supplier options, formulates counter-proposals, and synthesizes operational narratives.
- **Deterministic code enforces:** Spending caps, decimal monetary arithmetic, Haversine delivery boundaries, state transitions, and double-entry accounting balances are locked in immutable TypeScript code. The model cannot hallucinate funds, bypass a mandate, or skip a workflow stage.

### 2. Multilingual Grocery Understanding
Residents can express complex, multi-item grocery demands naturally:
> *"Mujhe 4 kilo jwari ka atta, 5 kilo chini, 3 kilo aalu, adha kilo tamatar, 1 kilo bhindi, aur 1 litre doodh chaiye along with 500 gram of oats. Keep the rate optimal."*

- **Indic & Hinglish Fraction Handling:** Understands colloquial fraction words (`adha`/`aadha` $\to 0.5$, `paav` $\to 0.25$ [guarded against *pav bhaji*], `dedh` $\to 1.5$, `dhai` $\to 2.5$, `sawa` $\to 1.25$, `paune` $\to 0.75$).
- **Universal Quantity Normalization:** Canonical dimension mapping (weight $\to$ grams/kg, volume $\to$ ml/litres, count $\to$ units/packs/dozen) with price sanity bounds. Whole-package math uses $\lceil\text{requested} / \text{packageSize}\rceil$ to prevent silent under-delivery.

### 3. Real-Time Price Discovery Grounded by Meta Web Search
Relay implements live internet grocery price discovery in [`RealtimePriceDiscoveryService.ts`](file:///Users/jivhesh/Desktop/Relay-fallback/backend/src/agent/pricing/RealtimePriceDiscoveryService.ts):
- **Live Search Tooling:** Dispatches structured search requests to Meta’s Responses API (`https://api.meta.ai/v1/responses`) using native `tools: [{ type: "web_search" }]`.
- **Privacy-Preserving Sanitization:** Resident flat numbers, building wings, and street addresses are stripped before external query dispatch; only macro-locality (city/district) is transmitted.
- **Honest Provenance Disclosure:** Items backed by live search results are tagged with a **`LIVE`** badge (`VERIFIED_LIVE_LISTING`) and clickable merchant citations (e.g., BigBasket, Blinkit, DMart). When offline or rate-limited, Relay transparently marks quotes as **`ESTIMATE`** (`INDICATIVE_MARKET_ESTIMATE`) using local benchmark tables. No URLs or stocks are ever fabricated.

### 4. Zero-PII Collective Supplier Negotiation
- **Demand Pooling:** Individual resident orders within a society are aggregated into wholesale lots (e.g., individual 2 kg orders consolidated into a 100 kg bulk lot).
- **Anonymization Boundary:** Suppliers receive only bulk product requirements and society gate delivery coordinates. No resident names, flat numbers, or individual payment profiles are exposed.
- **Autonomous Volume Leverage:** Relay uses collective volume to negotiate discounts and tighter delivery SLAs with qualified suppliers.

### 5. 4-Pillar Financial & Quantity Reconciliation
Before an order completes, the system verifies four mathematical invariants:
1. **Quantity Conservation:** $\sum(\text{Resident Allocated Quantities}) \equiv \text{Verified Fulfilled Quantity}$
2. **Monetary Conservation:** $\sum(\text{Resident Line Charges}) \equiv \text{Authoritative Procurement Subtotal}$
3. **Supplier Obligation Match:** $\text{Delivered Line Items} \equiv \text{Purchase Order Commitments}$
4. **Payment Linkage:** $\text{Settled Resident Mandate Payments} \equiv \text{Disbursed Supplier Payments}$

---

## Meta AI Integration & Model Architecture

Relay isolates model access behind a clean `ModelProvider` interface (`backend/src/agent/model/ModelProvider.ts`), providing strict separation between reasoning and execution.

| Provider | Identifier | Target Endpoint | Purpose |
| :--- | :--- | :--- | :--- |
| **`MetaModelProvider`** | `'meta'` / `'meta-model'` | `https://api.meta.ai/v1` | Primary production provider. Uses Meta's `muse-spark-1.3` with OpenAI-compatible chat completions wire format. |
| **`MetaSparkProvider`** | `'meta-spark'` | Configurable Meta API endpoint | Backward-compatible alias for the Meta Spark model deployment. |
| **`SparkOpenProvider`** | `'spark-open'` / `'open'` | `http://localhost:8000/v1` | Open-weight runtime provider (e.g., `spark-open-7b` or LLaMA variants) for self-hosted community edge deployments. |
| **`MockModelProvider`** | `'mock'` | Local in-memory | Deterministic, zero-cost offline test provider supporting scripted multi-step agent scenarios and failure injection. |

### Operational Health & Diagnostics
Relay provides an authenticated diagnostic endpoint at `POST /api/health/integrations` protected by `INTEGRATION_DIAGNOSTIC_TOKEN`. It executes [`MetaModelProvider.probeConnectivity()`](file:///Users/jivhesh/Desktop/Relay-fallback/backend/src/agent/model/MetaModelProvider.ts#L105) with a non-sensitive probe prompt (`Return exactly the word READY`) and a 256-token completion floor to monitor latency and authentication health without leaking credentials.

---

## The 13-Stage Autonomous Procurement Engine

Relay's primary execution engine is the **13-stage deterministic state machine** managed by `RelayOrchestrator` and `WorkflowExecutor`. Every stage is checkpointed to PostgreSQL and verified before advancing.

```
01 UNDERSTAND ──► 02 DISCOVER ──► 03 QUALIFY ──► 04 QUOTE ──► 05 NEGOTIATE ──► 06 SELECT
                                                                                   │
13 COMPLETE   ◄── 12 RECONCILE ◄── 11 ALLOCATE ◄── 10 VERIFY ◄── 09 FULFILL ◄── 07 COMMIT
      ▲                                                                            │
      └──────────────────────────── 08 PAY ◄───────────────────────────────────────┘
```

1. **`UNDERSTAND`:** Intent extraction parses prompt into typed, normalized line items and validates society membership.
2. **`DISCOVER`:** Discovers commercial suppliers within geographic radius (via Geoapify Places API or local registry).
3. **`QUALIFY`:** Evaluates Minimum Order Quantities (MOQ), operating status, and 12-hour delivery SLA compliance.
4. **`QUOTE`:** Collects wholesale quotes and initiates live internet price discovery via Meta Responses API.
5. **`NEGOTIATE`:** Evaluates supplier margins and autonomously submits counter-proposals leveraging pooled demand.
6. **`SELECT`:** Multi-factor scoring algorithm (50% Price, 30% Reliability, 20% SLA) selects winning supplier.
7. **`COMMIT`:** Generates legally binding, confidential Purchase Orders (one per supplier allocation).
8. **`PAY`:** Verifies pre-authorized `PaymentMandate` spending limits and executes authorized payment hold.
9. **`FULFILL`:** Dispatches purchase order to supplier; tracks packaging and carrier dispatch.
10. **`VERIFY`:** Inspects proof-of-delivery confirmation evidence and packaging seals.
11. **`ALLOCATE`:** Distributes bulk goods back to individual resident accounts with zero cross-resident price leakage.
12. **`RECONCILE`:** Executes 4-pillar double-entry reconciliation across quantities, money, POs, and payments.
13. **`COMPLETE`:** Synchronizes transactional state to Prisma, notifies residents, and marks workflow terminal.

### Tool Registry Architecture
Relay registers **46 controlled tools** in `backend/src/agent/tools/definitions.ts`. Tools fall into three tiers:
- **Autonomous Workflow Tools:** `startWorkflow`, `getWorkflowState`, `executeWorkflowStep`, `resumeWorkflow`, `explainWorkflow` (drive the 13-stage engine).
- **Domain Subsystem Tools:** Specialist tools for RFQ, Negotiation, Selection, Commitment, Payment, Fulfillment, and Allocation inspection.
- **Legacy Mock Tools:** `createRequest`, `checkAuthorization`, `aggregateDemand`, `discoverSuppliers`, `evaluateOffers`, `selectOffer`, `createCommunityOrder`, `allocateResidentOrders`, `reconcileOrder`, `requestPayment`, and `trackDelivery` (maintained for backwards compatibility with Milestone 6 mock runs).

---

## Implementation Truthfulness & Simulation Disclosures

In compliance with engineering integrity guidelines, the table below distinguishes implemented capabilities from simulated and stubbed components:

| Component | Status | Details & Boundaries |
| :--- | :--- | :--- |
| **Reasoning & Planning** | **Implemented** | Real Meta `muse-spark-1.3` chat completions and multi-step tool execution. |
| **Price Discovery** | **Implemented** | Live search via Meta Responses API (`web_search`) with graceful local benchmark fallback. |
| **Quantity Normalization** | **Implemented** | Universal dimensional normalizer (`quantityNormalizer.ts`) for weight, volume, and count units. |
| **Workflow State Machine** | **Implemented** | 13-stage deterministic state machine with strict transition guards and checkpoints. |
| **Database & ORM** | **Implemented** | Full PostgreSQL persistence via Prisma ORM for users, mandates, orders, workflows, and audit events. |
| **Double-Entry Accounting** | **Implemented** | Mathematical 4-pillar reconciliation and resident ledger allocation. |
| **Web Frontend** | **Implemented** | Next.js 14 App Router, responsive dashboard, real-time mission execution stream, and command composer. |
| **Supplier Network** | *Simulated* | Business locations discovered via Geoapify, but wholesale responses and negotiations are simulated by local providers. |
| **Payment Gateway** | *Simulated* | Pre-authorized spending caps and ledger deductions are real; banking settlement uses `MockPaymentProvider` (`MOCK-TXN-...`). |
| **Logistics & Delivery** | *Simulated* | Tracked via `DeliverySimulator` deterministic state machine (`PREPARING` $\to$ `DELIVERED` with `TRK-SIM-...`); no physical couriers. |
| **Delivery Verification** | *Simulated* | Delivery evidence verified through state verification and simulated photo hash tokens. |

---

## User Interface & Screenshots

Real screenshots captured directly from Relay's Next.js frontend (`docs/screenshots/`):

| Command Center (`/`) | Autonomous Mission Stream (`/mission`) |
| :---: | :---: |
| ![Command Center](docs/screenshots/home-desktop.png) | ![Mission Stream](docs/screenshots/mission-desktop.png) |
| *Natural language composer, suggestion chips, and live operations overview.* | *Real-time 13-stage execution stream, unit normalization, and live quotes.* |

| Wholesale Quotes & Market (`/market`) | Consolidated Orders (`/orders`) |
| :---: | :---: |
| ![Market Quotes](docs/screenshots/market-desktop.png) | ![Orders](docs/screenshots/orders-desktop.png) |
| *Ranked supplier offers with SLA and reliability scoring.* | *Itemized community demand pooling and supplier purchase orders.* |

| Payment Mandates (`/payments`) | 4-Pillar Reconciliation (`/reconciliation`) |
| :---: | :---: |
| ![Payments](docs/screenshots/payments-desktop.png) | ![Reconciliation](docs/screenshots/reconciliation-desktop.png) |
| *Pre-authorized monthly spending caps and transaction settlement ledger.* | *Mathematical proof of zero financial and quantity discrepancies.* |

---

## Getting Started

### Prerequisites
- **Node.js:** `v18.x` or `v20.x`
- **npm:** `v9.x` or `v10.x`
- **PostgreSQL:** Local instance running on port `5432` or via Docker

### 1. Clone & Setup Database

```bash
git clone https://github.com/JivheshDharankar/Relay_META_AI_Developer_Hackathon.git
cd Relay_META_AI_Developer_Hackathon

# Option A: Start PostgreSQL with Docker
docker run --name relay-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=relay_db -p 5432:5432 -d postgres:15

# Option B: Using local PostgreSQL (macOS Homebrew)
brew services start postgresql@15
createdb relay_db
createdb relay_test
```

### 2. Configure & Start Backend

```bash
cd backend

# Install dependencies
npm install

# Configure environment
cp .env.example .env

# Run Prisma database migrations
npx prisma migrate dev

# Seed database with societies, residents, mandates, and suppliers
npm run db:seed

# Start backend server (runs on port 4000)
npm run dev
```

### 3. Configure & Start Frontend

```bash
cd ../frontend

# Install dependencies
npm install

# Configure environment
cp .env.example .env.local

# Start frontend development server (runs on port 3000)
npm run dev
```

Visit **[http://localhost:3000](http://localhost:3000)** in your browser.

> [!TIP]
> **Demo Login:** You can log in using Email OTP with any address (e.g. `resident@demo.com`). In local development mode (`NODE_ENV=development`), the verification OTP code is **`123456`**.

---

## Environment Variables Reference

### Backend (`backend/.env`)

```ini
# Core Server Configuration
PORT=4000
NODE_ENV=development
CORS_ORIGIN=http://localhost:3000
FRONTEND_URL=http://localhost:3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/relay_db
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/relay_test

# Meta AI Model Provider Configuration
# Set MODEL_PROVIDER=meta and supply META_MODEL_API_KEY for live Meta AI inference.
MODEL_PROVIDER=mock
MAX_AGENT_STEPS=20
META_MODEL_API_KEY=your_meta_api_key_here
META_MODEL_NAME=muse-spark-1.3
META_MODEL_BASE_URL=https://api.meta.ai/v1
META_MODEL_TIMEOUT_MS=30000

# Open-Weight Edge Deployment (Optional)
SPARK_OPEN_BASE_URL=http://localhost:8000/v1
SPARK_OPEN_MODEL_NAME=spark-open-7b

# External Provider Integrations (Optional)
GEOAPIFY_API_KEY=your_geoapify_key_here
GEOAPIFY_BASE_URL=https://api.geoapify.com
SUPPLIER_DISCOVERY_PROVIDER=mock

# Authentication (Optional Production Providers)
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=http://localhost:4000/api/auth/google/callback
SMS_PROVIDER=mock

# Operational Diagnostics
INTEGRATION_DIAGNOSTIC_TOKEN=your_secure_diagnostic_token_here
```

### Frontend (`frontend/.env.local`)

```ini
NEXT_PUBLIC_API_URL=http://localhost:4000
```

---

## Verification & Testing Suite

Relay includes a comprehensive automated test battery across both frontend and backend repositories.

### Verified Test Summary

| Test Suite | Framework | Files | Scope & Invariants |
| :--- | :--- | :---: | :--- |
| **Frontend Tests** | Vitest 2.1 | **27 files / 186 passed** | Shell guards, OAuth grant exchange, demo mode, routing, stage cards, evidence fidelity. |
| **Backend Unit & E2E** | Vitest 2.1 | **68 files / 1,662 tests** | 68 test files containing 1,662 declared automated test cases. The documented core verification suite has 23 passing tests. |
| **Backend TypeScript** | `tsc --noEmit` | **0 errors** | Strict mode TypeScript compilation across entire backend. |
| **Frontend Production Build** | Next.js 14.2 | **25/25 routes** | All static and server-rendered routes compile and optimize with zero build errors. |

### Running Verification Commands

```bash
# 1. Run core backend normalizer, discovery, and E2E workflow tests
cd backend
npx vitest run tests/quantity-normalizer.test.ts tests/realtime-price-discovery.test.ts tests/grocery-procurement-e2e.test.ts

# 2. Run backend TypeScript build verification
npm run build

# 3. Run full frontend automated test suite (186 tests)
cd ../frontend
npm test

# 4. Run frontend production Next.js build (25 routes)
npm run build
```

---

## Project Roadmap

### Completed (Hackathon Submission)
- [x] Multi-item natural language intent extraction with Indic/Hinglish fraction disambiguation.
- [x] Universal quantity normalizer eliminating cross-dimensional conversion errors (grams/kg, ml/L, packs).
- [x] Live internet grocery price discovery grounded by Meta Responses API (`web_search`).
- [x] Deterministic 13-stage autonomous procurement state machine (`RelayOrchestrator`).
- [x] Pre-authorized spending mandate verification with database concurrency controls.
- [x] Society demand pooling with strictly anonymized supplier-facing purchase orders.
- [x] Autonomous multi-round counter-proposal negotiation engine.
- [x] Mathematical 4-pillar reconciliation (Quantity, Monetary, PO, Payment).
- [x] Next.js 14 frontend with real-time SSE execution stream, portals, and dark-mode command center.

### Future Development
- [ ] **Live Payment Gateway (PSP) Integration:** Integration with Razorpay / Stripe for real UPI AutoPay and card mandates.
- [ ] **Physical Delivery Driver App:** Progressive Web App for community gate security and delivery couriers with QR-code seal verification.
- [ ] **WhatsApp / SMS Conversational Interface:** Direct conversational procurement via Meta WhatsApp Business API and Twilio SMS.
- [ ] **Automated GST Invoicing & ERP Sync:** Generation of statutory e-invoices with HSN code classification and housing society accounting software connectors (e.g. MyGate, ADDA).

---

## License

This project is licensed under the [MIT License](LICENSE). Built with pride for the **Meta Global AI Developer Hackathon**.
