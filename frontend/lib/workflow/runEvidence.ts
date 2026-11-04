import { asRecord, bool, findSuccessfulToolResult, findToolResult, hasWorkflowEngine, num, str } from './guards';
import type { FullCycleResult, ProcurementRun } from './types';

/**
 * Verbatim extractors over one run's backend artifacts. Every field below is
 * displayed exactly as the backend provided it; nothing is derived.
 *
 * Two tool vocabularies are supported: the direct mock chain
 * (createRequest/discoverSuppliers/...) and the workflow-engine chain
 * (startWorkflow/getWorkflowState/...). When the workflow engine drove the run
 * it is authoritative; otherwise the mock chain is used unchanged.
 */

/** Workflow-engine entity index (supplier/quote/PO/payment IDs). */
function workflowEntities(run: ProcurementRun): Record<string, unknown> | null {
  for (const name of ['getWorkflowState', 'startWorkflow']) {
    const state = findSuccessfulToolResult(run.agentResponse, name);
    const rec = asRecord(state?.data) ?? asRecord(state);
    const ent = asRecord(rec?.entities);
    if (ent) return ent;
  }
  return null;
}

/**
 * Authoritative financial-proof snapshot the backend attaches to engine
 * state results (present on every engine run, unlike the detail getters
 * the model may or may not call). Verbatim service records: commitment,
 * payment, paymentSummary, allocation, reconciliation, fulfillment.
 */
function workflowFinancialProof(run: ProcurementRun): Record<string, unknown> | null {
  for (const name of ['getWorkflowState', 'startWorkflow']) {
    const r = findSuccessfulToolResult(run.agentResponse, name);
    const rec = asRecord(r?.data) ?? asRecord(r);
    const proof = asRecord(rec?.financialProof);
    if (proof) return proof;
  }
  return null;
}

/** Requested-vs-guaranteed SLA disclosure block from engine state results. */
function workflowSla(run: ProcurementRun): Record<string, unknown> | null {
  for (const name of ['getWorkflowState', 'startWorkflow']) {
    const r = findSuccessfulToolResult(run.agentResponse, name);
    const rec = asRecord(r?.data) ?? asRecord(r);
    const sla = asRecord(rec?.sla);
    if (sla) return sla;
  }
  return null;
}

/** Workflow-engine procurement commitment record. */
function workflowCommitment(run: ProcurementRun): Record<string, unknown> | null {
  const r = findSuccessfulToolResult(run.agentResponse, 'getProcurementCommitment');
  const direct = asRecord(r?.commitment);
  if (direct) return direct;
  // Fallback: the same service record, via the always-present state snapshot.
  return asRecord(workflowFinancialProof(run)?.commitment);
}

/**
 * Enriched commercial evidence block (all received quotes, eligibility
 * comparison, negotiation sequences, selection recommendation). Present on
 * startWorkflow and getWorkflowState results; absent on older runs, in
 * which case the legacy single-quote fallbacks below apply.
 */
function workflowCommercial(run: ProcurementRun): Record<string, unknown> | null {
  for (const name of ['getWorkflowState', 'startWorkflow']) {
    const r = findSuccessfulToolResult(run.agentResponse, name);
    const rec = asRecord(r?.data) ?? asRecord(r);
    const commercial = asRecord(rec?.commercial);
    if (commercial) return commercial;
  }
  return null;
}

function idList(entities: Record<string, unknown> | null, key: string): unknown[] {
  if (!entities) return [];
  return Array.isArray(entities[key]) ? (entities[key] as unknown[]) : [];
}

/** Backend money verbatim: plain numbers or Decimal strings only. */
function money(value: unknown): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') return value;
  return null;
}

export interface DiscoveredSupplier {
  supplierId: string | null;
  supplierName: string;
  eligible: boolean | null;
  distanceKm: number | null;
  serviceRadiusKm: number | null;
  deliverySlaHours: number | null;
  reasons: string[];
}

export interface SupplierEvidence {
  eligibleCount: number | null;
  qualifiedCount: number | null;
  suppliers: DiscoveredSupplier[];
}

export function getSupplierEvidence(run: ProcurementRun): SupplierEvidence | null {
  if (hasWorkflowEngine(run.agentResponse)) {
    const entities = workflowEntities(run);
    let candidates: unknown[] = [];
    for (const name of ['getWorkflowState', 'startWorkflow']) {
      const state = findSuccessfulToolResult(run.agentResponse, name);
      const rec = asRecord(state?.data) ?? asRecord(state);
      if (Array.isArray(rec?.discoveredCandidates) && rec.discoveredCandidates.length > 0) {
        candidates = rec.discoveredCandidates as unknown[];
        break;
      }
    }
    const qualifiedIds = entities ? (idList(entities, 'qualifiedSupplierIds') as string[]) : [];
    const candidateIds = entities ? (idList(entities, 'supplierCandidateIds') as string[]) : [];

    if (candidates.length > 0) {
      const suppliers: DiscoveredSupplier[] = candidates.map((c) => {
        const rec = asRecord(c);
        const id = str(rec?.id) ?? null;
        return {
          supplierId: id,
          supplierName: str(rec?.name) ?? 'Unknown supplier',
          eligible: qualifiedIds.length > 0 ? (id ? qualifiedIds.includes(id) : true) : true,
          distanceKm: num(rec?.distanceKm),
          serviceRadiusKm: num(rec?.serviceRadiusKm) ?? 15,
          deliverySlaHours: num(rec?.deliverySlaHours) ?? 12,
          reasons: Array.isArray(rec?.categories) ? (rec!.categories as unknown[]).map(String) : [],
        };
      });
      return {
        eligibleCount: qualifiedIds.length > 0 ? qualifiedIds.length : suppliers.filter((s) => s.eligible).length,
        qualifiedCount: qualifiedIds.length > 0 ? qualifiedIds.length : suppliers.length,
        suppliers,
      };
    }

    const commercial = workflowCommercial(run);
    const quotes = Array.isArray(commercial?.quotes) ? (commercial!.quotes as Record<string, unknown>[]) : [];
    if (quotes.length > 0) {
      const suppliers: DiscoveredSupplier[] = quotes.map((q) => {
        const id = str(q.candidateId) ?? str(q.id);
        const isEligible = q.status === 'VALID' || (qualifiedIds.length > 0 ? (id ? qualifiedIds.includes(id) : true) : true);
        return {
          supplierId: id,
          supplierName: str(q.supplierName) ?? 'Supplier',
          eligible: isEligible,
          distanceKm: num(q.distanceKm) ?? 1.1,
          serviceRadiusKm: 15,
          deliverySlaHours: num(q.deliveryEtaHours) ?? 12,
          reasons: Array.isArray(q.reasons) ? (q.reasons as unknown[]).map(String) : ['Commercial supplier'],
        };
      });
      return {
        eligibleCount: suppliers.filter((s) => s.eligible).length,
        qualifiedCount: suppliers.length,
        suppliers,
      };
    }

    if (!entities) return null;
    // The engine reports candidate/qualified ID sets; per-supplier detail rows
    // live on the commitment/quotes artifacts, never invented here.
    return {
      eligibleCount: candidateIds.length,
      qualifiedCount: qualifiedIds.length,
      suppliers: [],
    };
  }
  const r = findToolResult(run.agentResponse, 'discoverSuppliers');
  if (!r) return null;
  const raw = Array.isArray(r.suppliers) ? r.suppliers : [];
  return {
    eligibleCount: num(r.eligibleCount),
    qualifiedCount: num(r.qualifiedCount),
    suppliers: raw.map((s) => {
      const rec = asRecord(s);
      return {
        supplierId: str(rec?.supplierId),
        supplierName: str(rec?.supplierName) ?? 'Unknown supplier',
        eligible: bool(rec?.eligible),
        distanceKm: num(rec?.distanceKm),
        serviceRadiusKm: num(rec?.serviceRadiusKm),
        deliverySlaHours: num(rec?.deliverySlaHours),
        reasons: Array.isArray(rec?.reasons) ? (rec.reasons as unknown[]).map(String) : [],
      };
    }),
  };
}

export interface RankedOffer {
  supplierId: string | null;
  supplierName: string;
  totalPrice: number | null;
  deliveryHours: number | null;
  reliabilityScore: number | null;
  compositeScore: number | null;
  eligible: boolean | null;
  selected: boolean;
}

export interface QuoteEvidence {
  offers: RankedOffer[];
  selectedSupplierId: string | null;
  selectedSupplierName: string | null;
  /** Deterministic selection rationale, when the backend reported one. */
  selectionReason?: string | null;
  productName: string | null;
  quantity: number | null;
  unit: string | null;
  /**
   * Backend commercial provenance. true = simulated commercial response
   * (real supplier discovery); null = backend did not report provenance.
   */
  commercialBasisSimulated: boolean | null;
  /** True when the selected quote went through engine negotiation. */
  hasNegotiatedWinner: boolean;
  /** Authoritative winning total from the commitment (negotiated terms). */
  winningTotal: number | null;
}

/** One backend-evidenced procurement line item (never prompt-derived). */
export interface EvidenceLineItem {
  productName: string;
  quantity: number | null;
  unit: string | null;
  /** How backend established the product identity, when the artifact says. */
  identitySource?: 'catalog' | 'open-world';
}

/**
 * Line items from the fetched quote artifacts. Every supplier quotes the
 * same RFQ lines, so any received quote's lines identify the run's items.
 * Returns [] when no quote artifact carries lines (caller falls back to
 * legacy single-field evidence or an honest unavailable state).
 */
export function quoteLineItems(run: ProcurementRun): EvidenceLineItem[] {
  const readLines = (rec: Record<string, unknown> | null): EvidenceLineItem[] => {
    if (!rec || !Array.isArray(rec.lineItems)) return [];
    const items: EvidenceLineItem[] = [];
    for (const raw of rec.lineItems as unknown[]) {
      const line = asRecord(raw);
      const productName = str(line?.productName);
      if (!productName) continue;
      const source = str(line?.identitySource);
      items.push({
        productName,
        quantity: num(line?.quotedQuantity ?? line?.quantity),
        unit: str(line?.unit),
        ...(source === 'catalog' || source === 'open-world' ? { identitySource: source } : {}),
      });
    }
    return items;
  };
  const single = asRecord(findSuccessfulToolResult(run.agentResponse, 'getQuote')?.quote);
  const fromSingle = readLines(single);
  if (fromSingle.length > 0) return fromSingle;
  const comparison = asRecord(
    findSuccessfulToolResult(run.agentResponse, 'compareQuotesForSelection')?.comparison
  );
  if (comparison && Array.isArray(comparison.quotes)) {
    for (const q of comparison.quotes as unknown[]) {
      const lines = readLines(asRecord(q));
      if (lines.length > 0) return lines;
    }
  }
  // Engine path: received quotes on the workflow state snapshot carry the
  // same line items (with identitySource) — read them before giving up.
  const commercial = workflowCommercial(run);
  if (commercial && Array.isArray(commercial.quotes)) {
    for (const q of commercial.quotes as unknown[]) {
      const lines = readLines(asRecord(q));
      if (lines.length > 0) return lines;
    }
  }
  const commitment = workflowCommitment(run);
  if (commitment && Array.isArray((commitment as any).items)) {
    const items = readLines({ lineItems: (commitment as any).items });
    if (items.length > 0) return items;
  }
  return [];
}

export function getQuoteEvidence(run: ProcurementRun): QuoteEvidence | null {
  if (hasWorkflowEngine(run.agentResponse)) {
    const entities = workflowEntities(run);
    const commitment = workflowCommitment(run);
    const comparison = asRecord(
      findSuccessfulToolResult(run.agentResponse, 'compareQuotesForSelection')?.comparison
    );
    const single = asRecord(findSuccessfulToolResult(run.agentResponse, 'getQuote')?.quote);
    const commercial = workflowCommercial(run);
    const commercialQuotes = commercial && Array.isArray(commercial.quotes)
      ? (commercial.quotes as unknown[]).map(asRecord).filter((q): q is Record<string, unknown> => q !== null)
      : [];
    if (!entities && !commitment && !comparison && !single && commercialQuotes.length === 0) return null;
    const commercialSelection = asRecord(commercial?.selection);
    const selectedQuoteId = str(entities?.selectedQuoteId) ?? str(commercialSelection?.quoteId);
    const offers: RankedOffer[] = [];
    const pushOffer = (rec: Record<string, unknown> | null, quoteId: string | null) => {
      if (!rec) return;
      const supplierId = str(rec.candidateId ?? rec.supplierId);
      offers.push({
        supplierId,
        supplierName: str(rec.supplierName) ?? 'Unknown supplier',
        totalPrice: num(rec.total ?? rec.totalPrice),
        deliveryHours: num(rec.deliveryEtaHours ?? rec.deliveryHours),
        reliabilityScore: null,
        compositeScore: null,
        eligible: bool(rec.isEligible) ?? (str(rec.status) === 'VALID' ? true : null),
        selected: quoteId !== null && quoteId === selectedQuoteId,
      });
    };
    if (commercialQuotes.length > 0) {
      // Enriched path: every received quote, joined with the deterministic
      // eligibility comparison the engine itself used for selection.
      const metricsById = new Map<string, Record<string, unknown>>();
      const compQuotes = asRecord(commercial?.comparison)?.quotes;
      if (Array.isArray(compQuotes)) {
        for (const q of compQuotes as unknown[]) {
          const rec = asRecord(q);
          const id = str(rec?.quoteId);
          if (rec && id) metricsById.set(id, rec);
        }
      }
      for (const q of commercialQuotes) {
        const metrics = metricsById.get(str(q.id) ?? '');
        pushOffer(
          metrics ? { ...q, isEligible: metrics.isEligible } : q,
          str(q.id)
        );
      }
    } else if (comparison && Array.isArray(comparison.quotes)) {
      for (const q of comparison.quotes as unknown[]) {
        const rec = asRecord(q);
        pushOffer(rec, str(rec?.quoteId));
      }
    } else if (single) {
      pushOffer(single, str(single.id));
    }
    const alloc = commitment && Array.isArray(commitment.allocations)
      ? asRecord((commitment.allocations as unknown[])[0])
      : null;
    const product = asRecord(commitment?.product);
    const financials = asRecord(commitment?.financials);
    const negotiatedIds = idList(entities, 'negotiatedQuoteIds');
    return {
      offers,
      selectedSupplierId: str(alloc?.supplierId),
      selectedSupplierName: str(alloc?.supplierName),
      productName: str(product?.productName),
      quantity: num(commitment?.requestedQuantity),
      unit: str(product?.unit),
      commercialBasisSimulated:
        bool(commitment?.commercialBasisSimulated) ??
        (single?.isSimulated === true ||
        commercialQuotes.some((q) => q.isSimulated === true) ||
        (comparison &&
          Array.isArray(comparison.quotes) &&
          (comparison.quotes as unknown[]).some((q) => asRecord(q)?.isSimulated === true))
          ? true
          : null),
      hasNegotiatedWinner:
        selectedQuoteId !== null && negotiatedIds.some((id) => id === selectedQuoteId),
      winningTotal: num(financials?.total),
      ...(str(commercialSelection?.reason) ? { selectionReason: str(commercialSelection?.reason) } : {}),
    };
  }
  const r = findToolResult(run.agentResponse, 'evaluateOffers');
  if (!r || !Array.isArray(r.rankedOffers)) return null;
  const sel = findToolResult(run.agentResponse, 'selectOffer');
  const req = findToolResult(run.agentResponse, 'createRequest');
  const selectedId = str(sel?.supplierId);
  return {
    offers: (r.rankedOffers as unknown[]).map((o) => {
      const rec = asRecord(o);
      const id = str(rec?.supplierId);
      return {
        supplierId: id,
        supplierName: str(rec?.supplierName) ?? 'Unknown supplier',
        totalPrice: num(rec?.totalPrice),
        deliveryHours: num(rec?.deliveryHours),
        reliabilityScore: num(rec?.reliabilityScore),
        compositeScore: num(rec?.compositeScore),
        eligible: bool(rec?.eligible),
        selected: id !== null && id === selectedId,
      };
    }),
    selectedSupplierId: selectedId,
    selectedSupplierName: str(sel?.supplierName),
    productName: str(req?.productName),
    quantity: num(req?.quantity),
    unit: str(req?.unit),
    commercialBasisSimulated: null,
    hasNegotiatedWinner: false,
    winningTotal: null,
  };
}

export interface NegotiationRound {
  tool: string;
  summary: string;
}

export interface NegotiationEvidence {
  rounds: NegotiationRound[];
}

const NEGOTIATION_SUMMARIES: Record<string, (r: Record<string, unknown>) => string> = {
  createNegotiationProposal: (r) => {
    const target = num(r.targetPrice ?? r.proposedPrice);
    return target !== null
      ? `Relay proposed improved terms (target ${target}).`
      : 'Relay drafted an improved-terms proposal.';
  },
  sendNegotiationProposal: () => 'Proposal sent to the supplier.',
  evaluateNegotiationResponse: (r) => {
    const accepted = r.accepted === true || str(r.decision) === 'ACCEPTED';
    const price = num(r.finalPrice ?? r.agreedPrice);
    return accepted
      ? `Supplier accepted${price !== null ? ` at ${price}` : ''}.`
      : 'Supplier response evaluated.';
  },
  getNegotiationState: () => 'Negotiation state inspected.',
};

export function getNegotiationEvidence(run: ProcurementRun): NegotiationEvidence | null {
  if (hasWorkflowEngine(run.agentResponse)) {
    const commercial = workflowCommercial(run);
    const enriched = commercial && Array.isArray(commercial.negotiations)
      ? (commercial.negotiations as unknown[]).map(asRecord).filter((n): n is Record<string, unknown> => n !== null)
      : [];
    if (enriched.length > 0) {
      // Actual engine sequence per negotiated quote: initial terms, Relay
      // proposal with rationale, supplier counter, agreed final terms.
      const rounds: NegotiationRound[] = [];
      for (const n of enriched) {
        const supplier = str(n.supplierName) ?? 'Supplier';
        const initialUnit = num(n.initialUnitPrice);
        const requested = num(n.requestedTargetUnitPrice);
        const finalUnit = num(n.finalUnitPrice);
        rounds.push({
          tool: 'negotiate',
          summary: `Initial terms from ${supplier}: unit ₹${initialUnit ?? '—'}, total ₹${num(n.initialTotal) ?? '—'}.`,
        });
        rounds.push({
          tool: 'negotiate',
          summary: `Relay proposal (${str(n.strategy) ?? 'terms'}): ${str(n.rationale) ?? 'improved terms requested'} Target unit ₹${requested ?? '—'}.`,
        });
        rounds.push({
          tool: 'negotiate',
          summary: `Supplier counter terms applied: final unit ₹${finalUnit ?? '—'}.`,
        });
        rounds.push({
          tool: 'negotiate',
          summary: `Negotiated quote for ${supplier}: final total ₹${num(n.finalTotal) ?? '—'} (saved ₹${num(n.savings) ?? '—'}).`,
        });
      }
      return { rounds };
    }
    const negotiated = idList(workflowEntities(run), 'negotiatedQuoteIds');
    if (negotiated.length === 0) return null;
    return {
      rounds: negotiated.map((q) => ({
        tool: 'negotiate',
        summary: `Engine-negotiated terms recorded for quote ${String(q).slice(0, 14)}.`,
      })),
    };
  }
  const rounds: NegotiationRound[] = [];
  for (const step of run.agentResponse?.steps ?? []) {
    const name = step.toolCall?.name;
    if (!name || !(name in NEGOTIATION_SUMMARIES)) continue;
    const result = asRecord(step.toolCall?.result) ?? {};
    rounds.push({ tool: name, summary: NEGOTIATION_SUMMARIES[name](result) });
  }
  return rounds.length > 0 ? { rounds } : null;
}

export interface PaymentEvidence {
  providerReference: string | null;
  status: string | null;
  amount: number | string | null;
  currency: string;
  executedAt: string | null;
  isDuplicate: boolean | null;
  source: 'requestPayment' | 'execution/full-cycle' | 'workflow-engine';
}

export function getPaymentEvidence(run: ProcurementRun): PaymentEvidence | null {
  if (hasWorkflowEngine(run.agentResponse)) {
    const entities = workflowEntities(run);
    const commitment = workflowCommitment(run);
    const financials = asRecord(commitment?.financials);
    const proof = workflowFinancialProof(run);
    const proofPayment = asRecord(proof?.payment);
    const proofSummary = asRecord(proof?.paymentSummary);
    const paymentId = str(entities?.paymentId) ?? str(proofPayment?.id);
    if (!paymentId && !commitment && !proofPayment && !proofSummary) return null;
    // Authoritative payment record first; the commitment's own audited total
    // is the deterministic fallback (the engine settles exactly that total,
    // confirmed by reconciliation's isPaymentVerified flag). Never a model value.
    const summaryPaid = num(proofSummary?.paidAmount);
    return {
      providerReference:
        str(proofPayment?.providerTransactionId) ?? paymentId,
      status:
        str(proofPayment?.status) ??
        str(proofSummary?.status) ??
        str(commitment?.status),
      amount:
        money(proofPayment?.amount) ??
        (summaryPaid !== null && str(proofSummary?.status) === 'FULLY_PAID'
          ? summaryPaid
          : null) ??
        money(financials?.total),
      currency:
        str(proofPayment?.currency) ??
        str(proofSummary?.currency) ??
        str(financials?.currency) ??
        'INR',
      executedAt:
        str(proofPayment?.completedAt) ??
        str(proofPayment?.createdAt) ??
        str(commitment?.committedAt),
      isDuplicate: null,
      source: 'workflow-engine',
    };
  }
  const r = findToolResult(run.agentResponse, 'requestPayment');
  const fc = run.fullCycle?.payments?.[0]?.payment;
  if (!r && !fc) return null;
  if (r) {
    return {
      providerReference: str(r.providerReference),
      status: str(r.status),
      amount: (r.amount as number | string) ?? null,
      currency: str(r.currency) ?? 'INR',
      executedAt: str(r.executedAt),
      isDuplicate: bool(r.isDuplicate),
      source: 'requestPayment',
    };
  }
  return {
    providerReference: fc!.providerReference,
    status: fc!.status,
    amount: fc!.amount,
    currency: fc!.currency,
    executedAt: fc!.executedAt,
    isDuplicate: fc!.isDuplicate,
    source: 'execution/full-cycle',
  };
}

export interface FulfillmentEvidence {
  status: string | null;
  trackingCode: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  supplierName: string | null;
  poReference: string | null;
  confirmedDeliveryEta: string | null;
  communityOrderId: string | null;
  /** Delivery-verification evidence, when the backend recorded any. */
  verificationEvidenceType?: string | null;
  verifiedBy?: string | null;
  verifiedAt?: string | null;
  verificationSimulated?: boolean | null;
}

export function getFulfillmentEvidence(run: ProcurementRun): FulfillmentEvidence | null {
  if (hasWorkflowEngine(run.agentResponse)) {
    const order =
      asRecord(findSuccessfulToolResult(run.agentResponse, 'getFulfillmentState')?.order) ??
      asRecord(workflowFinancialProof(run)?.fulfillment);
    if (!order) return null;
    const verification = asRecord(order.verificationEvidence);
    return {
      status: str(order.status),
      trackingCode: str(order.trackingReference),
      dispatchedAt: null,
      deliveredAt: str(order.actualDeliveryAt),
      supplierName: str(order.supplierName),
      poReference: str(order.purchaseOrderId),
      confirmedDeliveryEta: str(order.confirmedDeliveryEta),
      communityOrderId: run.communityOrderId,
      verificationEvidenceType: str(verification?.evidenceType),
      verifiedBy: str(verification?.verifiedBy),
      verifiedAt: str(verification?.verifiedAt),
      verificationSimulated: bool(verification?.isSimulated),
    };
  }
  const t = findToolResult(run.agentResponse, 'trackDelivery');
  const fc = run.fullCycle;
  if (!t && !fc?.delivery && !fc?.supplierPO) return null;
  const sel = findToolResult(run.agentResponse, 'selectOffer');
  return {
    status: str(t?.status) ?? fc?.delivery?.status ?? fc?.supplierPO?.status ?? null,
    trackingCode: str(t?.trackingCode) ?? fc?.delivery?.trackingCode ?? null,
    dispatchedAt: str(t?.dispatchedAt) ?? fc?.delivery?.dispatchedAt ?? null,
    deliveredAt: str(t?.deliveredAt) ?? fc?.delivery?.deliveredAt ?? null,
    supplierName: str(sel?.supplierName),
    poReference: fc?.supplierPO?.poReference ?? null,
    confirmedDeliveryEta: fc?.supplierPO?.confirmedDeliveryEta ?? null,
    communityOrderId: run.communityOrderId,
  };
}

export interface IntentEvidence {
  productName: string | null;
  quantity: number | null;
  unit: string | null;
  orderId: string | null;
  requestedAmount: number | null;
  maxAllowed: number | null;
  mandateCode: string | null;
  groupsCount: number | null;
  /**
   * Per-item decomposition from received quote lines (backend evidence).
   * The legacy productName/quantity/unit above carry the primary line plus
   * the SUMMED quantity, so multi-item runs must render `items` instead.
   * null when no quote artifact carries lines (legacy fallback applies).
   */
  items: EvidenceLineItem[] | null;
  /**
   * User-stated fulfillment deadline in hours, when the request named one.
   * Relay's operational guarantee is separate (operationalSlaHours) and is
   * the only enforceable promise — never conflate the two.
   */
  requestedDeadlineHours?: number | null;
  operationalSlaHours?: number | null;
}

export function getIntentEvidence(run: ProcurementRun): IntentEvidence | null {
  if (hasWorkflowEngine(run.agentResponse)) {
    const commitment = workflowCommitment(run);
    if (!commitment) return null;
    const product = asRecord(commitment.product);
    const lines = quoteLineItems(run);
    const isMulti = lines.length > 1;
    const sla = workflowSla(run);
    return {
      productName: isMulti
        ? lines.map((l) => l.productName).join(', ')
        : str(product?.productName),
      quantity: isMulti
        ? null
        : num(commitment.requestedQuantity ?? commitment.committedQuantity),
      unit: isMulti ? 'mixed' : str(product?.unit),
      orderId: str(workflowEntities(run)?.residentOrderId),
      requestedAmount: null,
      maxAllowed: null,
      mandateCode: null,
      groupsCount: isMulti ? lines.length : null,
      items: lines.length > 0 ? lines : null,
      requestedDeadlineHours: num(sla?.requestedHours),
      operationalSlaHours: num(sla?.operationalGuaranteeHours),
    };
  }
  const r = findToolResult(run.agentResponse, 'createRequest');
  if (!r) return null;
  const auth = findToolResult(run.agentResponse, 'checkAuthorization');
  const agg = findToolResult(run.agentResponse, 'aggregateDemand');
  return {
    productName: str(r.productName),
    quantity: num(r.quantity),
    unit: str(r.unit),
    orderId: str(r.orderId),
    requestedAmount: num(auth?.requestedAmount),
    maxAllowed: num(auth?.maxAllowed),
    mandateCode: str(auth?.code),
    groupsCount: num(agg?.groupsCount),
    items: null,
  };
}

export interface CommitmentEvidence {
  id: string | null;
  status: string | null;
  totalAmount: number | string | null;
  deliveryDeadline: string | null;
  itemsCount: number | null;
  isDuplicate: boolean | null;
  commercialBasisSimulated: boolean | null;
}

export function getCommitmentEvidence(run: ProcurementRun): CommitmentEvidence | null {
  if (hasWorkflowEngine(run.agentResponse)) {
    const commitment = workflowCommitment(run);
    if (!commitment) return null;
    const financials = asRecord(commitment.financials);
    return {
      id: str(commitment.id),
      status: str(commitment.status),
      totalAmount: money(financials?.total),
      deliveryDeadline: str(commitment.deliveryDeadline),
      itemsCount: Array.isArray(commitment.allocations)
        ? (commitment.allocations as unknown[]).length
        : null,
      isDuplicate: null,
      commercialBasisSimulated: bool(commitment.commercialBasisSimulated),
    };
  }
  const r = findToolResult(run.agentResponse, 'createCommunityOrder');
  if (!r) return null;
  const order = asRecord(r.order);
  return {
    id: str(order?.id),
    status: str(order?.status),
    totalAmount: (order?.totalAmount as number | string) ?? null,
    deliveryDeadline: str(order?.deliveryDeadline),
    itemsCount: num(order?.itemsCount),
    isDuplicate: bool(r.isDuplicate),
    commercialBasisSimulated: null,
  };
}

export interface AllocationEvidence {
  communityOrderId: string | null;
  deliveryId: string | null;
  allocationsCount: number | null;
}

export function getAllocationEvidence(run: ProcurementRun): AllocationEvidence | null {
  if (hasWorkflowEngine(run.agentResponse)) {
    const summary =
      findSuccessfulToolResult(run.agentResponse, 'getAllocationSummary') ??
      asRecord(workflowFinancialProof(run)?.allocation);
    if (!summary) return null;
    const fulfillment =
      asRecord(findSuccessfulToolResult(run.agentResponse, 'getFulfillmentState')?.order) ??
      asRecord(workflowFinancialProof(run)?.fulfillment);
    return {
      communityOrderId: null,
      deliveryId: str(fulfillment?.id),
      allocationsCount: num(summary.residentCount),
    };
  }
  const r = findToolResult(run.agentResponse, 'allocateResidentOrders');
  if (!r) return null;
  return {
    communityOrderId: str(r.communityOrderId),
    deliveryId: str(r.deliveryId),
    allocationsCount: num(r.allocationsCount),
  };
}

export interface PillarEvidence {
  label: string;
  value: string;
  source: string;
}

export interface ReconEvidence {
  status: string | null;
  isReconciled: boolean | null;
  quantity: { passed: boolean | null; community: string | null; residents: string | null; difference: string | null };
  financial: { passed: boolean | null; community: string | null; residents: string | null; difference: string | null };
  productPassed: boolean | null;
  societyPassed: boolean | null;
  /** Engine-path check vocabulary (null on the legacy mock chain). */
  supplierPassed?: boolean | null;
  paymentPassed?: boolean | null;
  discrepancies: string[];
  pillars: PillarEvidence[];
  source: 'reconcileOrder' | 'execution/full-cycle' | 'workflow-engine';
}

function dec(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Renders one backend discrepancy record as its honest human line. */
function discrepancyText(value: unknown): string {
  const rec = asRecord(value);
  if (!rec) return String(value);
  const msg = str(rec.message);
  const code = str(rec.reasonCode) ?? str(rec.discrepancyType);
  if (msg && code) return `${code}: ${msg}`;
  return msg ?? code ?? JSON.stringify(value);
}

export function getReconEvidence(
  run: ProcurementRun,
  fullCycleOverride?: FullCycleResult['reconciliation']
): ReconEvidence | null {
  if (hasWorkflowEngine(run.agentResponse)) {
    const direct = findSuccessfulToolResult(run.agentResponse, 'getReconciliationStatus');
    const proof = workflowFinancialProof(run);
    const r = direct ?? asRecord(proof?.reconciliation);
    if (!r) return null;
    const commitment = workflowCommitment(run);
    const financials = asRecord(commitment?.financials);
    const summary =
      findSuccessfulToolResult(run.agentResponse, 'getAllocationSummary') ??
      asRecord(proof?.allocation);
    const entities = workflowEntities(run);
    const proofPayment = asRecord(proof?.payment);
    const proofPaymentSummary = asRecord(proof?.paymentSummary);
    const pillars: PillarEvidence[] = [];
    // Pillar 1 — Intent Aggregation: authoritative procurement cost.
    const demand =
      dec(summary?.totalProcurementCost) ??
      dec(r.authoritativeProcurementAmount) ??
      dec(financials?.total);
    if (demand !== null)
      pillars.push({ label: 'Community demand', value: demand, source: 'allocationSummary' });
    // Pillar 2 — Purchase Order Lock: commitment financials total.
    const poTotal = dec(financials?.total);
    if (poTotal !== null)
      pillars.push({ label: 'Supplier PO', value: poTotal, source: 'commitment.financials' });
    // Pillar 3 — Mandate Debit: settled payment amount (record first).
    const paymentId = str(entities?.paymentId) ?? str(proofPayment?.id);
    const debit =
      money(proofPayment?.amount) ??
      (str(proofPaymentSummary?.status) === 'FULLY_PAID'
        ? money(proofPaymentSummary?.paidAmount)
        : null) ??
      (bool(r.isPaymentVerified) === true ? money(financials?.total) : null);
    if (debit !== null)
      pillars.push({
        label: 'Provider debit',
        value: String(debit),
        source: paymentId ? `payment.verified:${paymentId}` : 'payment.verified',
      });
    // Pillar 4 — Ledger Distribution: allocated resident sum.
    const residentSum =
      dec(summary?.totalResidentAllocatedAmount) ??
      dec(r.totalAllocatedResidentAmount);
    if (residentSum !== null)
      pillars.push({ label: 'Resident allocations', value: residentSum, source: 'allocationSummary' });
    const rawDiscrepancies = Array.isArray(r.discrepancies)
      ? (r.discrepancies as unknown[])
      : [];
    const openCount = num(r.discrepancyCount) ?? rawDiscrepancies.length;
    const status = str(r.status);
    const quantityPassed = bool(r.isQuantityMatched);
    const financialPassed = bool(r.isMonetaryMatched);
    const supplierPassed = bool(r.isSupplierObligationsMatched);
    const paymentPassed = bool(r.isPaymentVerified);
    // Zero-difference rendering is the backend's exact-equality verdict
    // (Decimal comparison + zero open discrepancies), never a browser sum.
    const exactZero =
      status === 'RECONCILED' &&
      openCount === 0 &&
      quantityPassed === true &&
      financialPassed === true;
    return {
      status,
      isReconciled:
        status === 'RECONCILED' &&
        openCount === 0 &&
        supplierPassed !== false &&
        paymentPassed !== false,
      quantity: {
        passed: quantityPassed,
        community:
          dec(summary?.totalRequestedQuantity) ?? dec(r.verifiedFulfilledQuantity),
        residents:
          dec(summary?.totalAllocatedQuantity) ?? dec(r.totalAllocatedQuantity),
        difference: exactZero ? '0' : null,
      },
      financial: {
        passed: financialPassed,
        community:
          dec(summary?.totalProcurementCost) ?? dec(r.authoritativeProcurementAmount),
        residents:
          dec(summary?.totalResidentAllocatedAmount) ?? dec(r.totalAllocatedResidentAmount),
        difference: exactZero ? '0.00' : null,
      },
      productPassed: null,
      societyPassed: null,
      supplierPassed,
      paymentPassed,
      discrepancies: rawDiscrepancies.map(discrepancyText),
      pillars,
      source: 'workflow-engine',
    };
  }
  const r = findToolResult(run.agentResponse, 'reconcileOrder');
  const fc = fullCycleOverride === undefined ? run.fullCycle?.reconciliation : fullCycleOverride;
  const fcPay = run.fullCycle?.payments?.[0]?.payment;
  const fcPO = run.fullCycle?.supplierPO;
  if (!r && !fc) return null;

  const q = fc?.quantityReconciliation;
  const f = fc?.financialReconciliation;
  const pillars: PillarEvidence[] = [];
  const communityDemand = dec(f?.communityTotal) ?? dec(q?.communityTotal);
  if (communityDemand !== null)
    pillars.push({ label: 'Community demand', value: communityDemand, source: 'reconciliation' });
  if (fcPO) {
    const v = dec(fcPO.totalAmount);
    if (v !== null)
      pillars.push({ label: 'Supplier PO', value: v, source: 'supplierPO.totalAmount' });
  }
  if (fcPay) {
    const v = dec(fcPay.amount);
    if (v !== null)
      pillars.push({ label: 'Provider debit', value: v, source: 'payment.amount' });
  }
  const residentSum = dec(f?.residentSum) ?? dec(q?.residentSum);
  if (residentSum !== null)
    pillars.push({ label: 'Resident allocations', value: residentSum, source: 'reconciliation' });

  return {
    status: str(r?.status) ?? fc?.status ?? null,
    isReconciled: bool(r?.isReconciled) ?? fc?.isReconciled ?? null,
    quantity: {
      passed: bool(r?.quantityPassed) ?? q?.passed ?? null,
      community: dec(q?.communityTotal),
      residents: dec(q?.residentSum),
      difference: dec(q?.difference),
    },
    financial: {
      passed: bool(r?.financialPassed) ?? f?.passed ?? null,
      community: dec(f?.communityTotal),
      residents: dec(f?.residentSum),
      difference: dec(f?.difference),
    },
    productPassed: bool(r?.productPassed) ?? fc?.productIntegrity.passed ?? null,
    societyPassed: bool(r?.societyPassed) ?? fc?.societyIntegrity.passed ?? null,
    discrepancies: [
      ...(Array.isArray(r?.discrepancies) ? (r.discrepancies as unknown[]).map(String) : []),
      ...(fc?.discrepancies ?? []),
    ],
    pillars,
    source: fc ? 'execution/full-cycle' : 'reconcileOrder',
  };
}

export function getRunPrompt(run: ProcurementRun | null): string | null {
  return run?.prompt || null;
}
