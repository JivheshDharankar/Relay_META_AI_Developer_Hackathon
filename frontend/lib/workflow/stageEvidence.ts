import { formatMoney, formatQuantity, shortRef } from '@/lib/format';
import type { AgentRunResponse, AgentStep } from '@/types';
import { asRecord, findSuccessfulToolResult, hasWorkflowEngine, num, str } from './guards';
import { quoteLineItems } from './runEvidence';
import type { ToolResult } from './guards';
import type { FullCycleResult, ProcurementRun } from './types';

export type CanonicalStage =
  | 'UNDERSTAND'
  | 'DISCOVER'
  | 'QUALIFY'
  | 'QUOTE'
  | 'NEGOTIATE'
  | 'SELECT'
  | 'COMMIT'
  | 'PAY'
  | 'FULFILL'
  | 'VERIFY'
  | 'ALLOCATE'
  | 'RECONCILE'
  | 'COMPLETE';

export const CANONICAL_STAGES: { stage: CanonicalStage; label: string }[] = [
  { stage: 'UNDERSTAND', label: 'Understand' },
  { stage: 'DISCOVER', label: 'Discover' },
  { stage: 'QUALIFY', label: 'Qualify' },
  { stage: 'QUOTE', label: 'Quote' },
  { stage: 'NEGOTIATE', label: 'Negotiate' },
  { stage: 'SELECT', label: 'Select' },
  { stage: 'COMMIT', label: 'Commit' },
  { stage: 'PAY', label: 'Pay' },
  { stage: 'FULFILL', label: 'Fulfill' },
  { stage: 'VERIFY', label: 'Verify' },
  { stage: 'ALLOCATE', label: 'Allocate' },
  { stage: 'RECONCILE', label: 'Reconcile' },
  { stage: 'COMPLETE', label: 'Complete' },
];

export const STAGE_SLUGS: Record<CanonicalStage, string | null> = {
  UNDERSTAND: 'understand',
  DISCOVER: 'discover',
  QUALIFY: 'qualify',
  QUOTE: 'quotes',
  NEGOTIATE: 'negotiation',
  SELECT: 'selection',
  COMMIT: 'commitment',
  PAY: 'payment',
  FULFILL: 'fulfillment',
  VERIFY: 'verification',
  ALLOCATE: 'allocation',
  RECONCILE: 'reconciliation',
  COMPLETE: null,
};

/** verified = backend evidence present; absent = no evidence this run; failed = backend reported failure. */
export type StageState = 'verified' | 'absent' | 'failed';

export interface StageFact {
  label: string;
  value: string;
}

export interface StageEvidence {
  stage: CanonicalStage;
  label: string;
  state: StageState;
  summary: string;
  facts: StageFact[];
  /** Which backend artifact backs this stage (tool name or endpoint). */
  source: string | null;
  /** Backend failure code for failed stages, when the artifact carries one. */
  code?: string | null;
}

function collectToolResults(response: AgentRunResponse | null): Map<string, ToolResult> {
  const map = new Map<string, ToolResult>();
  for (const step of response?.steps ?? []) {
    const call = (step as AgentStep).toolCall;
    if (!call) continue;
    const result = asRecord(call.result);
    // NEVER read step.thought: chain-of-thought must not enter the view layer.
    if (result && !map.has(call.name)) {
      map.set(call.name, result);
    }
  }
  return map;
}

function collectToolErrors(response: AgentRunResponse | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const step of response?.steps ?? []) {
    const call = (step as AgentStep).toolCall;
    if (!call?.error) continue;
    const message = str((call.error as Record<string, unknown>).message) ?? 'Tool call failed';
    if (!map.has(call.name)) map.set(call.name, message);
  }
  return map;
}

function collectToolErrorCodes(response: AgentRunResponse | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const step of response?.steps ?? []) {
    const call = (step as AgentStep).toolCall;
    if (!call?.error) continue;
    const code = str((call.error as Record<string, unknown>).code);
    if (code && !map.has(call.name)) map.set(call.name, code);
  }
  return map;
}

const NEGOTIATION_TOOLS = new Set([
  'createNegotiationProposal',
  'sendNegotiationProposal',
  'evaluateNegotiationResponse',
  'getNegotiationState',
]);

/**
 * Maps one procurement run's backend artifacts onto the 13 canonical stages.
 * Every `verified` stage cites its source artifact. Stages without evidence
 * are `absent`, never invented.
 */
export function mapRunToStages(run: ProcurementRun): StageEvidence[] {
  const tools = collectToolResults(run.agentResponse);
  const toolErrors = collectToolErrors(run.agentResponse);
  const toolErrorCodes = collectToolErrorCodes(run.agentResponse);
  const fullCycle: FullCycleResult | null = run.fullCycle;
  // Meta path: the workflow engine drove this run. Its artifacts take
  // precedence; exploratory mock-tool errors from the same run must not shadow
  // the engine's authoritative outcome.
  const wf =
    hasWorkflowEngine(run.agentResponse) ||
    tools.has('getWorkflowState') ||
    tools.has('startWorkflow') ||
    Boolean(tools.get('startWorkflow')?.workflowId) ||
    Boolean(asRecord(tools.get('startWorkflow')?.data)?.workflowId);
  const wfEntities = (): Record<string, unknown> | null => {
    const state = tools.get('getWorkflowState') || tools.get('startWorkflow');
    const data = asRecord(state?.data) || state;
    return asRecord(data?.entities);
  };
  const wfCommitment = (): Record<string, unknown> | null => {
    const direct = asRecord(tools.get('getProcurementCommitment')?.commitment);
    if (direct) return direct;
    const state = tools.get('getWorkflowState') || tools.get('startWorkflow');
    const data = asRecord(state?.data) || state;
    return asRecord(asRecord(data?.financialProof)?.commitment);
  };
  const wfIdList = (key: string): unknown[] => {
    const entities = wfEntities();
    return entities && Array.isArray(entities[key]) ? (entities[key] as unknown[]) : [];
  };
  // Engine progress checklist: authoritative per-stage completion. Read-back
  // detail artifacts depend on which getters the model happened to call; the
  // progress record does not, so completed runs map deterministically.
  const wfProgress = (): Map<string, { status: string | null; completedAt: string | null }> => {
    const map = new Map<string, { status: string | null; completedAt: string | null }>();
    const state = tools.get('getWorkflowState') || tools.get('startWorkflow');
    const data = asRecord(state?.data) || state;
    const progress =
      (data && Array.isArray(data.progress) ? (data.progress as unknown[]) : []) ||
      (state && Array.isArray(state?.progress) ? (state.progress as unknown[]) : []);
    for (const entry of progress) {
      const rec = asRecord(entry);
      const stage = str(rec?.stage);
      if (stage) map.set(stage, { status: str(rec?.status), completedAt: str(rec?.completedAt) });
    }
    return map;
  };
  const wfProgressMap = wfProgress();
  const wfProgressed = (stage: string): boolean =>
    wfProgressMap.get(stage)?.status === 'COMPLETED';
  const wfStageFailed = (stage: string): boolean =>
    wfProgressMap.get(stage)?.status === 'FAILED';
  const wfProgressFacts = (stage: string): StageFact[] => {
    const completedAt = wfProgressMap.get(stage)?.completedAt;
    return completedAt ? [{ label: 'Completed', value: completedAt }] : [];
  };

  // Authoritative workflow failure stage and failure reason detection
  const wfStateData =
    asRecord(tools.get('getWorkflowState')?.data) ||
    tools.get('getWorkflowState') ||
    asRecord(tools.get('startWorkflow')?.data) ||
    tools.get('startWorkflow');
  const wfStatus = str(wfStateData?.status);
  const wfCurrentStage = str(wfStateData?.currentStage);
  const explicitFailedEntry = Array.from(wfProgressMap.entries()).find(([, val]) => val.status === 'FAILED');
  const failedWorkflowStage = explicitFailedEntry
    ? explicitFailedEntry[0]
    : wfStatus === 'FAILED' && wfCurrentStage
      ? wfCurrentStage
      : null;
  const wfFailureReason =
    str(wfStateData?.failureReason) ||
    toolErrors.get('startWorkflow') ||
    str(tools.get('startWorkflow')?.error) ||
    run.error?.message;

  const failed = (stage: CanonicalStage, label: string, source: string | null, summary: string, code?: string | null): StageEvidence => ({
    stage, label, state: 'failed', summary, facts: [], source, code: code ?? null,
  });
  const absent = (stage: CanonicalStage, label: string, summary: string): StageEvidence => ({
    stage, label, state: 'absent', summary, facts: [], source: null,
  });

  const out: StageEvidence[] = [];

  // 1. UNDERSTAND
  // A returned (non-thrown) startWorkflow failure — e.g. a deterministic
  // mandate block — is authoritative evidence of a halted run, on either path.
  const wfAttempt = findSuccessfulToolResult(run.agentResponse, 'startWorkflow');
  const isExplicitUnderstandFailed =
    failedWorkflowStage === 'UNDERSTAND' ||
    (wfAttempt && wfAttempt.success === false && !failedWorkflowStage && !wfProgressed('UNDERSTAND'));

  if (isExplicitUnderstandFailed) {
    out.push(
      failed(
        'UNDERSTAND',
        'Understand',
        'startWorkflow',
        wfFailureReason ?? str(wfAttempt?.error) ?? 'Workflow initialization failed.'
      )
    );
  } else if (wf) {
    const r = tools.get('startWorkflow');
    const commitment = wfCommitment();
    const product = asRecord(commitment?.product);
    const hasIntentEvidence =
      r ||
      commitment ||
      wfProgressed('UNDERSTAND') ||
      (failedWorkflowStage !== null && failedWorkflowStage !== 'UNDERSTAND');

    if (hasIntentEvidence) {
      const qty = num(commitment?.requestedQuantity ?? commitment?.committedQuantity);
      const productName = str(product?.productName);
      const unit = str(product?.unit);
      const wfId = str(r?.workflowId) ?? str(wfStateData?.workflowId);
      // Per-item lines from received quote artifacts (backend evidence).
      // The commitment carries only the primary line plus the SUMMED
      // quantity, so multi-item runs list lines instead of merging them.
      const lines = quoteLineItems(run);
      const facts: StageFact[] = [];
      if (wfId) facts.push({ label: 'Workflow', value: shortRef(wfId) });
      if (lines.length > 1) {
        for (const line of lines) {
          facts.push({
            label: 'Item',
            value: `${formatQuantity(line.quantity ?? '?', line.unit || undefined)} ${line.productName}`,
          });
        }
      } else if (productName) {
        facts.push({
          label: 'Parsed demand',
          value: `${formatQuantity(qty ?? '?', unit || undefined)} ${productName}`,
        });
      }
      const identified =
        lines.length > 1
          ? lines.map((l) => `${formatQuantity(l.quantity ?? '?', l.unit || undefined)} ${l.productName}`).join('; ')
          : productName && qty !== null
            ? `${formatQuantity(qty, unit || undefined)} ${productName}`
            : null;
      out.push({
        stage: 'UNDERSTAND',
        label: 'Understand',
        state: 'verified',
        summary: identified
          ? `Identified ${identified}; autonomous workflow initialized.`
          : `Autonomous workflow initialized${wfId ? ` (${shortRef(wfId)})` : ''}.`,
        facts,
        source: 'startWorkflow',
      });
    } else {
      out.push(absent('UNDERSTAND', 'Understand', 'No intent evidence in this run.'));
    }
  }
  if (!wf) {
    const r = tools.get('createRequest');
    const err = toolErrors.get('createRequest');
    if (err || (r && r.success === false)) {
      out.push(failed('UNDERSTAND', 'Understand', 'createRequest', err ?? 'Request creation failed.'));
    } else if (r) {
      const qty = num(r.quantity);
      const product = str(r.productName) ?? 'requested product';
      const unit = str(r.unit) ?? '';
      const auth = tools.get('checkAuthorization');
      const agg = tools.get('aggregateDemand');
      const facts: StageFact[] = [];
      const orderId = str(r.orderId);
      if (orderId) facts.push({ label: 'Resident order', value: shortRef(orderId, 'ORD-') });
      facts.push({
        label: 'Parsed demand',
        value: formatQuantity(qty ?? String(r.quantity ?? '?'), unit || undefined),
      });
      if (auth) {
        const req = num(auth.requestedAmount);
        const max = num(auth.maxAllowed);
        facts.push({
          label: 'Mandate check',
          value:
            req !== null && max !== null
              ? req <= max
                ? `${formatMoney(req)} within ${formatMoney(max)}`
                : `${formatMoney(req)} exceeds ${formatMoney(max)} — blocked`
              : String(auth.code ?? auth.authorized ?? 'checked'),
        });
      }
      if (agg) {
        const groups = num(agg.groupsCount);
        facts.push({
          label: 'Community pool',
          value: groups !== null ? `${groups} product groups pooled` : 'demand pooled',
        });
      }
      out.push({
        stage: 'UNDERSTAND',
        label: 'Understand',
        state: 'verified',
        summary: `Identified ${formatQuantity(qty ?? String(r.quantity ?? '?'), unit || undefined)} ${product}.`,
        facts,
        source: 'createRequest',
      });
    } else if (run.agentResponse && tools.size === 0) {
      // The run stopped before any tool ran (e.g. UNMAPPABLE_PRODUCT): the
      // command was received but no product mapping exists. Surface the
      // agent's own honest message as the blocked state.
      out.push(
        failed(
          'UNDERSTAND',
          'Understand',
          null,
          run.agentResponse.response?.trim() || 'Product mapping unavailable for this request.'
        )
      );
    } else {
      out.push(absent('UNDERSTAND', 'Understand', 'No intent evidence in this run.'));
    }
  }

  // 2. DISCOVER
  if (wf) {
    const entities = wfEntities();
    const err = toolErrors.get('getWorkflowState');
    if (failedWorkflowStage === 'DISCOVER') {
      out.push(failed('DISCOVER', 'Discover', 'startWorkflow', wfFailureReason ?? 'Supplier discovery failed.'));
    } else if (entities) {
      const candidates = wfIdList('supplierCandidateIds').length;
      out.push({
        stage: 'DISCOVER',
        label: 'Discover',
        state: 'verified',
        summary: `Found ${candidates} commercial candidates through real supplier discovery.`,
        facts: [{ label: 'Candidates', value: String(candidates) }],
        source: 'getWorkflowState',
      });
    } else if (wfProgressed('DISCOVER')) {
      out.push({
        stage: 'DISCOVER',
        label: 'Discover',
        state: 'verified',
        summary: 'Commercial supplier discovery completed per engine progress record.',
        facts: wfProgressFacts('DISCOVER'),
        source: 'getWorkflowState',
      });
    } else if (err) {
      out.push(failed('DISCOVER', 'Discover', 'getWorkflowState', err));
    } else {
      out.push(absent('DISCOVER', 'Discover', 'No discovery evidence in this run.'));
    }
  }
  if (!wf) {
    const r = tools.get('discoverSuppliers');
    const err = toolErrors.get('discoverSuppliers');
    if (err || (r && r.success === false)) {
      out.push(failed('DISCOVER', 'Discover', 'discoverSuppliers', err ?? 'Supplier discovery failed.'));
    } else if (r) {
      const qualified = num(r.qualifiedCount);
      const eligible = num(r.eligibleCount);
      out.push({
        stage: 'DISCOVER',
        label: 'Discover',
        state: 'verified',
        summary:
          qualified !== null
            ? `Found ${qualified} eligible commercial suppliers within the configured search area.`
            : 'Supplier discovery completed.',
        facts:
          eligible !== null || qualified !== null
            ? [
                ...(eligible !== null ? [{ label: 'Eligible', value: String(eligible) }] : []),
                ...(qualified !== null ? [{ label: 'Qualified', value: String(qualified) }] : []),
              ]
            : [],
        source: 'discoverSuppliers',
      });
    } else {
      out.push(absent('DISCOVER', 'Discover', 'No discovery evidence in this run.'));
    }
  }

  // 3. QUALIFY
  if (wf) {
    const entities = wfEntities();
    if (failedWorkflowStage === 'QUALIFY') {
      out.push(failed('QUALIFY', 'Qualify', 'startWorkflow', wfFailureReason ?? 'Supplier qualification failed.'));
    } else if (entities) {
      const candidates = wfIdList('supplierCandidateIds').length;
      const qualified = wfIdList('qualifiedSupplierIds').length;
      out.push({
        stage: 'QUALIFY',
        label: 'Qualify',
        state: 'verified',
        summary: `Qualified ${qualified} of ${candidates} candidates against SLA, radius, and capability constraints.`,
        facts: [{ label: 'Qualified', value: `${qualified} of ${candidates}` }],
        source: 'getWorkflowState',
      });
    } else if (wfProgressed('QUALIFY')) {
      out.push({
        stage: 'QUALIFY',
        label: 'Qualify',
        state: 'verified',
        summary: 'Supplier qualification completed per engine progress record.',
        facts: wfProgressFacts('QUALIFY'),
        source: 'getWorkflowState',
      });
    } else if (toolErrors.get('getWorkflowState')) {
      out.push(failed('QUALIFY', 'Qualify', 'getWorkflowState', 'Qualification evidence unavailable: state read failed.'));
    } else {
      out.push(absent('QUALIFY', 'Qualify', 'No qualification evidence in this run.'));
    }
  }
  if (!wf) {
    const r = tools.get('discoverSuppliers');
    const suppliers = Array.isArray(r?.suppliers) ? (r.suppliers as unknown[]) : null;
    if (r && suppliers) {
      const passed = suppliers.filter((s) => asRecord(s)?.eligible === true).length;
      const failedSuppliers = suppliers
        .map(asRecord)
        .filter((s) => s && s.eligible === false);
      const facts: StageFact[] = [
        { label: 'Qualified', value: `${passed} of ${suppliers.length}` },
      ];
      for (const s of failedSuppliers.slice(0, 3)) {
        const reasons = Array.isArray(s!.reasons) ? (s!.reasons as unknown[]).map(String) : [];
        facts.push({
          label: str(s!.supplierName) ?? 'Supplier',
          value: reasons.length > 0 ? reasons.join('; ') : 'did not meet constraints',
        });
      }
      out.push({
        stage: 'QUALIFY',
        label: 'Qualify',
        state: 'verified',
        summary: `Qualified ${passed} of ${suppliers.length} candidates against SLA, radius, and capability constraints.`,
        facts,
        source: 'discoverSuppliers',
      });
    } else if (toolErrors.get('discoverSuppliers')) {
      out.push(failed('QUALIFY', 'Qualify', 'discoverSuppliers', 'Qualification evidence unavailable: discovery failed.'));
    } else {
      out.push(absent('QUALIFY', 'Qualify', 'No qualification evidence in this run.'));
    }
  }

  // 4. QUOTE
  if (wf) {
    const received = wfIdList('receivedQuoteIds').length;
    const comparison = asRecord(tools.get('compareQuotesForSelection')?.comparison);
    const single = asRecord(tools.get('getQuote')?.quote);
    const eligible =
      comparison && Array.isArray(comparison.eligibleQuotes)
        ? (comparison.eligibleQuotes as unknown[]).length
        : single
          ? (str(single.status) === 'VALID' ? 1 : 0)
          : null;
    if (failedWorkflowStage === 'QUOTE') {
      out.push(failed('QUOTE', 'Quote', 'startWorkflow', wfFailureReason ?? 'Quote evaluation failed.'));
    } else if (received > 0 || comparison || single) {
      const facts: StageFact[] = [{ label: 'Quotes received', value: String(Math.max(received, eligible ?? 0)) }];
      if (eligible !== null) facts.push({ label: 'Eligible', value: String(eligible) });
      const simulated =
        (comparison && Array.isArray(comparison.quotes) &&
          (comparison.quotes as unknown[]).some((q) => asRecord(q)?.isSimulated === true)) ||
        single?.isSimulated === true ||
        asRecord(tools.get('getProcurementCommitment')?.commitment)?.commercialBasisSimulated === true;
      if (simulated) {
        facts.push({ label: 'Commercial basis', value: 'Simulated (per backend record)' });
      }
      out.push({
        stage: 'QUOTE',
        label: 'Quote',
        state: 'verified',
        summary:
          eligible !== null
            ? `Ranked ${Math.max(received, eligible)} normalized offers; ${eligible} eligible for selection.`
            : `Received ${received} normalized supplier quotes.`,
        facts,
        source: comparison ? 'compareQuotesForSelection' : single ? 'getQuote' : 'getWorkflowState',
      });
    } else if (wfProgressed('QUOTE')) {
      out.push({
        stage: 'QUOTE',
        label: 'Quote',
        state: 'verified',
        summary: 'Supplier quotes collected and normalized per engine progress record.',
        facts: wfProgressFacts('QUOTE'),
        source: 'getWorkflowState',
      });
    } else {
      out.push(absent('QUOTE', 'Quote', 'No quote evidence in this run.'));
    }
  }
  if (!wf) {
    const r = tools.get('evaluateOffers');
    const err = toolErrors.get('evaluateOffers');
    const ranked = Array.isArray(r?.rankedOffers) ? (r.rankedOffers as unknown[]) : null;
    if (err || (r && r.success === false)) {
      out.push(failed('QUOTE', 'Quote', 'evaluateOffers', err ?? 'Offer evaluation failed.'));
    } else if (r && ranked) {
      const eligibleCount = ranked.filter((o) => asRecord(o)?.eligible === true).length;
      out.push({
        stage: 'QUOTE',
        label: 'Quote',
        state: 'verified',
        summary: `Ranked ${ranked.length} normalized offers; ${eligibleCount} eligible for selection.`,
        facts: [{ label: 'Offers ranked', value: String(ranked.length) }],
        source: 'evaluateOffers',
      });
    } else {
      out.push(absent('QUOTE', 'Quote', 'No quote evidence in this run.'));
    }
  }

  // 5. NEGOTIATE
  if (wf) {
    const negotiated = wfIdList('negotiatedQuoteIds').length;
    if (failedWorkflowStage === 'NEGOTIATE') {
      out.push(failed('NEGOTIATE', 'Negotiate', 'startWorkflow', wfFailureReason ?? 'Supplier negotiation failed.'));
    } else if (negotiated > 0) {
      out.push({
        stage: 'NEGOTIATE',
        label: 'Negotiate',
        state: 'verified',
        summary: 'Relay negotiated improved commercial terms with shortlisted suppliers.',
        facts: [{ label: 'Negotiated quotes', value: String(negotiated) }],
        source: 'getWorkflowState',
      });
    } else if (wfProgressed('NEGOTIATE')) {
      out.push({
        stage: 'NEGOTIATE',
        label: 'Negotiate',
        state: 'verified',
        summary: 'Negotiation stage completed per engine progress record (no separate counter-round recorded).',
        facts: wfProgressFacts('NEGOTIATE'),
        source: 'getWorkflowState',
      });
    } else {
      out.push(
        absent(
          'NEGOTIATE',
          'Negotiate',
          'No negotiation round in this run — selection proceeded on quoted terms.'
        )
      );
    }
  }
  if (!wf) {
    const rounds = [...NEGOTIATION_TOOLS].filter((t) => tools.has(t) || toolErrors.has(t));
    const failedRound = rounds.find((t) => toolErrors.has(t));
    if (failedRound) {
      out.push(failed('NEGOTIATE', 'Negotiate', failedRound, toolErrors.get(failedRound)!));
    } else if (rounds.length > 0) {
      out.push({
        stage: 'NEGOTIATE',
        label: 'Negotiate',
        state: 'verified',
        summary: 'Relay negotiated improved commercial terms with shortlisted suppliers.',
        facts: [{ label: 'Negotiation steps', value: String(rounds.length) }],
        source: rounds[0],
      });
    } else {
      out.push(
        absent(
          'NEGOTIATE',
          'Negotiate',
          'No negotiation round in this run — selection proceeded on quoted terms.'
        )
      );
    }
  }

  // 6. SELECT
  if (wf) {
    const commitment = wfCommitment();
    const alloc = commitment && Array.isArray(commitment.allocations)
      ? asRecord((commitment.allocations as unknown[])[0])
      : null;
    if (failedWorkflowStage === 'SELECT') {
      out.push(failed('SELECT', 'Select', 'startWorkflow', wfFailureReason ?? 'Supplier selection failed.'));
    } else if (commitment && alloc) {
      const name = str(alloc.supplierName) ?? 'supplier';
      const total = num(alloc.totalAmount);
      const sla = num(alloc.deliveryEtaHours);
      const facts: StageFact[] = [{ label: 'Supplier', value: name }];
      if (total !== null) facts.push({ label: 'Validated total', value: formatMoney(total) });
      if (sla !== null) facts.push({ label: 'SLA', value: `${sla}h` });
      const quoteId = str(alloc.quoteId);
      if (quoteId) facts.push({ label: 'Winning quote', value: shortRef(quoteId) });
      out.push({
        stage: 'SELECT',
        label: 'Select',
        state: 'verified',
        summary: `Selected ${name}${total !== null ? ` at ${formatMoney(total)}` : ''}${sla !== null ? ` (${sla}h SLA)` : ''}.`,
        facts,
        source: 'getProcurementCommitment',
      });
    } else if (wfProgressed('SELECT')) {
      out.push({
        stage: 'SELECT',
        label: 'Select',
        state: 'verified',
        summary: 'Winning supplier selected per engine progress record.',
        facts: wfProgressFacts('SELECT'),
        source: 'getWorkflowState',
      });
    } else {
      out.push(absent('SELECT', 'Select', 'No selection evidence in this run.'));
    }
  }
  if (!wf) {
    const r = tools.get('selectOffer');
    const err = toolErrors.get('selectOffer');
    if (err || (r && r.success === false)) {
      out.push(failed('SELECT', 'Select', 'selectOffer', err ?? 'Offer selection failed.'));
    } else if (r) {
      const name = str(r.supplierName) ?? 'supplier';
      const total = num(r.totalPrice);
      const sla = num(r.deliveryHours);
      const score = num(r.compositeScore);
      out.push({
        stage: 'SELECT',
        label: 'Select',
        state: 'verified',
        summary: `Selected ${name}${total !== null ? ` at ${formatMoney(total)}` : ''}${sla !== null ? ` (${sla}h SLA)` : ''}.`,
        facts: [
          { label: 'Supplier', value: name },
          ...(total !== null ? [{ label: 'Validated total', value: formatMoney(total) }] : []),
          ...(sla !== null ? [{ label: 'SLA', value: `${sla}h` }] : []),
          ...(score !== null ? [{ label: 'Composite score', value: score.toFixed(4) }] : []),
        ],
        source: 'selectOffer',
      });
    } else {
      out.push(absent('SELECT', 'Select', 'No selection evidence in this run.'));
    }
  }

  // 7. COMMIT
  if (wf) {
    const commitment = wfCommitment();
    if (failedWorkflowStage === 'COMMIT') {
      out.push(failed('COMMIT', 'Commit', 'startWorkflow', wfFailureReason ?? 'Procurement commitment failed.'));
    } else if (commitment) {
      const financials = asRecord(commitment.financials);
      const total = num(financials?.total);
      out.push({
        stage: 'COMMIT',
        label: 'Commit',
        state: 'verified',
        summary: `Purchase commitment created${total !== null ? ` at ${formatMoney(total)}` : ''}.`,
        facts: [
          ...(str(commitment.id) ? [{ label: 'Commitment', value: shortRef(commitment.id as string) }] : []),
          ...(str(commitment.status) ? [{ label: 'Status', value: commitment.status as string }] : []),
          ...(total !== null ? [{ label: 'Total', value: formatMoney(total) }] : []),
        ],
        source: 'getProcurementCommitment',
      });
    } else if (wfProgressed('COMMIT')) {
      out.push({
        stage: 'COMMIT',
        label: 'Commit',
        state: 'verified',
        summary: 'Purchase commitment created per engine progress record.',
        facts: wfProgressFacts('COMMIT'),
        source: 'getWorkflowState',
      });
    } else {
      out.push(absent('COMMIT', 'Commit', 'No commitment evidence in this run.'));
    }
  }
  if (!wf) {
    const r = tools.get('createCommunityOrder');
    const err = toolErrors.get('createCommunityOrder');
    const order = asRecord(r?.order);
    if (err || (r && r.success === false)) {
      out.push(failed('COMMIT', 'Commit', 'createCommunityOrder', err ?? 'Commitment creation failed.'));
    } else if (r && order) {
      const total = num(order.totalAmount);
      out.push({
        stage: 'COMMIT',
        label: 'Commit',
        state: 'verified',
        summary: `Purchase commitment created${total !== null ? ` at ${formatMoney(total)}` : ''}.`,
        facts: [
          ...(str(order.id) ? [{ label: 'Commitment', value: shortRef(order.id as string, 'COMM-') }] : []),
          ...(str(order.status) ? [{ label: 'Status', value: order.status as string }] : []),
          ...(total !== null ? [{ label: 'Total', value: formatMoney(total) }] : []),
        ],
        source: 'createCommunityOrder',
      });
    } else {
      out.push(absent('COMMIT', 'Commit', 'No commitment evidence in this run.'));
    }
  }

  // 8. PAY
  if (wf) {
    const entities = wfEntities();
    const commitment = wfCommitment();
    const state = tools.get('getWorkflowState') || tools.get('startWorkflow');
    const data = asRecord(state?.data) || state;
    const proof = asRecord(data?.financialProof);
    const proofPayment = asRecord(proof?.payment);
    const recon = tools.get('getReconciliationStatus') || asRecord(proof?.reconciliation);
    const paymentId = str(entities?.paymentId) || str(proofPayment?.id);
    const status = str(proofPayment?.status) || str(commitment?.status);
    const amount = num(proofPayment?.amount) ?? num(asRecord(commitment?.financials)?.total);
    const verified = recon?.isPaymentVerified === true;
    if (failedWorkflowStage === 'PAY') {
      out.push(failed('PAY', 'Pay', 'startWorkflow', wfFailureReason ?? 'Payment execution failed.'));
    } else if (paymentId || proofPayment || (commitment && (status === 'PAID' || status === 'SUCCEEDED'))) {
      const ok = status === null || status === 'PAID' || status === 'SUCCEEDED' || verified;
      out.push({
        stage: 'PAY',
        label: 'Pay',
        state: ok ? 'verified' : 'failed',
        summary:
          amount !== null
            ? `${ok ? 'Settled' : 'Payment ended as ' + (status ?? 'unknown') + ' for'} ${formatMoney(amount)} under the active mandate.`
            : 'Payment executed under the active mandate.',
        facts: [
          ...(paymentId ? [{ label: 'Payment', value: shortRef(paymentId) }] : []),
          ...(status ? [{ label: 'Status', value: status }] : []),
          ...(verified ? [{ label: 'Reconciliation', value: 'payment verified' }] : []),
        ],
        source: 'getProcurementCommitment',
      });
    } else if (wfProgressed('PAY')) {
      const paymentId = str(wfEntities()?.paymentId);
      out.push({
        stage: 'PAY',
        label: 'Pay',
        state: 'verified',
        summary: 'Payment settled per engine progress record.',
        facts: [
          ...(paymentId ? [{ label: 'Payment', value: shortRef(paymentId) }] : []),
          ...wfProgressFacts('PAY'),
        ],
        source: 'getWorkflowState',
      });
    } else {
      out.push(absent('PAY', 'Pay', 'No payment evidence in this run.'));
    }
  }
  if (!wf) {
    const r = tools.get('requestPayment');
    const err = toolErrors.get('requestPayment');
    const fcPayment = fullCycle?.payments?.[0];
    if (err || (r && r.success === false)) {
      out.push(failed('PAY', 'Pay', 'requestPayment', err ?? 'Payment execution failed.'));
    } else if (r || fcPayment) {
      const ref = str(r?.providerReference) ?? fcPayment?.payment.providerReference ?? null;
      const amount = num(r?.amount) ?? num(fcPayment?.payment.amount);
      const currency = str(r?.currency) ?? fcPayment?.payment.currency ?? 'INR';
      const status = str(r?.status) ?? fcPayment?.payment.status ?? null;
      const ok = status === null || status === 'SUCCESS';
      out.push({
        stage: 'PAY',
        label: 'Pay',
        state: ok ? 'verified' : 'failed',
        summary:
          amount !== null
            ? `${ok ? 'Settled' : 'Payment ended as ' + (status ?? 'unknown') + ' for'} ${formatMoney(amount, currency)} under the active mandate.`
            : 'Payment executed under the active mandate.',
        facts: [
          ...(ref ? [{ label: 'Provider reference', value: ref }] : []),
          ...(status ? [{ label: 'Status', value: status }] : []),
        ],
        source: r ? 'requestPayment' : 'execution/full-cycle',
      });
    } else {
      out.push(absent('PAY', 'Pay', 'No payment evidence in this run.'));
    }
  }

  // 9. FULFILL + 10. VERIFY share delivery evidence
  if (wf) {
    const state = tools.get('getWorkflowState') || tools.get('startWorkflow');
    const data = asRecord(state?.data) || state;
    const proof = asRecord(data?.financialProof);
    const order = asRecord(tools.get('getFulfillmentState')?.order) || asRecord(proof?.fulfillment);
    const err = toolErrors.get('getFulfillmentState');
    if (failedWorkflowStage === 'FULFILL') {
      out.push(failed('FULFILL', 'Fulfill', 'startWorkflow', wfFailureReason ?? 'Fulfillment execution failed.'));
      out.push(absent('VERIFY', 'Verify', 'Verification blocked: fulfillment failed.'));
    } else if (failedWorkflowStage === 'VERIFY') {
      if (order) {
        const status = str(order.status);
        const tracking = str(order.trackingReference);
        out.push({
          stage: 'FULFILL',
          label: 'Fulfill',
          state: 'verified',
          summary: status
            ? `Fulfillment ${status.toLowerCase().replace(/_/g, ' ')}${tracking ? ` · tracking ${tracking}` : ''}.`
            : 'Fulfillment tracked.',
          facts: [
            ...(status ? [{ label: 'Status', value: status }] : []),
            ...(tracking ? [{ label: 'Tracking', value: tracking }] : []),
            ...(str(order.purchaseOrderId) ? [{ label: 'Supplier PO', value: order.purchaseOrderId as string }] : []),
          ],
          source: 'getFulfillmentState',
        });
      } else if (wfProgressed('FULFILL')) {
        out.push({
          stage: 'FULFILL',
          label: 'Fulfill',
          state: 'verified',
          summary: 'Fulfillment completed per engine progress record.',
          facts: wfProgressFacts('FULFILL'),
          source: 'getWorkflowState',
        });
      } else {
        out.push(absent('FULFILL', 'Fulfill', 'No fulfillment evidence in this run.'));
      }
      out.push(failed('VERIFY', 'Verify', 'startWorkflow', wfFailureReason ?? 'Delivery verification failed.'));
    } else if (err) {
      out.push(failed('FULFILL', 'Fulfill', 'getFulfillmentState', err));
      out.push(failed('VERIFY', 'Verify', 'getFulfillmentState', err));
    } else if (order) {
      const status = str(order.status);
      const tracking = str(order.trackingReference);
      out.push({
        stage: 'FULFILL',
        label: 'Fulfill',
        state: 'verified',
        summary: status
          ? `Fulfillment ${status.toLowerCase().replace(/_/g, ' ')}${tracking ? ` · tracking ${tracking}` : ''}.`
          : 'Fulfillment tracked.',
        facts: [
          ...(status ? [{ label: 'Status', value: status }] : []),
          ...(tracking ? [{ label: 'Tracking', value: tracking }] : []),
          ...(str(order.purchaseOrderId) ? [{ label: 'Supplier PO', value: order.purchaseOrderId as string }] : []),
        ],
        source: 'getFulfillmentState',
      });
      const delivered = status === 'DELIVERED' || status === 'VERIFIED';
      const evidence = asRecord(order.verificationEvidence);
      if (delivered) {
        out.push({
          stage: 'VERIFY',
          label: 'Verify',
          state: 'verified',
          summary: `Delivery confirmed${tracking ? ` · ${tracking}` : ''}.`,
          facts: [
            ...(tracking ? [{ label: 'Tracking', value: tracking }] : []),
            ...(str(evidence?.evidenceType) ? [{ label: 'Evidence', value: evidence?.evidenceType as string }] : []),
          ],
          source: 'getFulfillmentState',
        });
      } else {
        out.push({
          stage: 'VERIFY',
          label: 'Verify',
          state: 'absent',
          summary: 'Delivery evidence received but not yet confirmed delivered.',
          facts: [],
          source: null,
        });
      }
    } else {
      if (wfProgressed('FULFILL')) {
        out.push({
          stage: 'FULFILL',
          label: 'Fulfill',
          state: 'verified',
          summary: 'Fulfillment completed per engine progress record.',
          facts: wfProgressFacts('FULFILL'),
          source: 'getWorkflowState',
        });
      } else {
        out.push(absent('FULFILL', 'Fulfill', 'No fulfillment evidence in this run.'));
      }
      if (wfProgressed('VERIFY')) {
        out.push({
          stage: 'VERIFY',
          label: 'Verify',
          state: 'verified',
          summary: 'Delivery verified per engine progress record.',
          facts: wfProgressFacts('VERIFY'),
          source: 'getWorkflowState',
        });
      } else {
        out.push(absent('VERIFY', 'Verify', 'No verification evidence in this run.'));
      }
    }
  }
  if (!wf) {
  const deliveryResult = tools.get('trackDelivery');
  const deliveryErr = toolErrors.get('trackDelivery');
  const fcDelivery = fullCycle?.delivery ?? null;
  const fcPO = fullCycle?.supplierPO ?? null;
  {
    if (deliveryErr || (deliveryResult && deliveryResult.success === false)) {
      out.push(failed('FULFILL', 'Fulfill', 'trackDelivery', deliveryErr ?? 'Fulfillment tracking failed.'));
    } else if (deliveryResult || fcDelivery || fcPO) {
      const status =
        str(deliveryResult?.status) ?? fcDelivery?.status ?? fcPO?.status ?? null;
      const tracking =
        str(deliveryResult?.trackingCode) ?? fcDelivery?.trackingCode ?? null;
      out.push({
        stage: 'FULFILL',
        label: 'Fulfill',
        state: 'verified',
        summary: status
          ? `Fulfillment ${status.toLowerCase().replace(/_/g, ' ')}${tracking ? ` · tracking ${tracking}` : ''}.`
          : 'Fulfillment tracked.',
        facts: [
          ...(status ? [{ label: 'Status', value: status }] : []),
          ...(tracking ? [{ label: 'Tracking', value: tracking }] : []),
          ...(fcPO?.poReference ? [{ label: 'Supplier PO', value: fcPO.poReference }] : []),
        ],
        source: deliveryResult ? 'trackDelivery' : 'execution/full-cycle',
      });
    } else {
      out.push(absent('FULFILL', 'Fulfill', 'No fulfillment evidence in this run.'));
    }
  }
  {
    const delivered =
      fcDelivery?.status === 'DELIVERED' || str(deliveryResult?.status) === 'DELIVERED';
    if (deliveryErr) {
      out.push(failed('VERIFY', 'Verify', 'trackDelivery', deliveryErr));
    } else if (delivered) {
      const tracking = fcDelivery?.trackingCode ?? str(deliveryResult?.trackingCode);
      out.push({
        stage: 'VERIFY',
        label: 'Verify',
        state: 'verified',
        summary: `Delivery confirmed${tracking ? ` · ${tracking}` : ''}.`,
        facts: tracking ? [{ label: 'Tracking', value: tracking }] : [],
        source: fcDelivery ? 'execution/full-cycle' : 'trackDelivery',
      });
    } else if (deliveryResult || fcDelivery) {
      out.push({
        stage: 'VERIFY',
        label: 'Verify',
        state: 'absent',
        summary: 'Delivery evidence received but not yet confirmed delivered.',
        facts: [],
        source: null,
      });
    } else {
      out.push(absent('VERIFY', 'Verify', 'No verification evidence in this run.'));
    }
  }
  }

  // 11. ALLOCATE
  if (wf) {
    const state = tools.get('getWorkflowState') || tools.get('startWorkflow');
    const data = asRecord(state?.data) || state;
    const proof = asRecord(data?.financialProof);
    const summary = tools.get('getAllocationSummary') || asRecord(proof?.allocation);
    const err = toolErrors.get('getAllocationSummary');
    if (failedWorkflowStage === 'ALLOCATE') {
      out.push(failed('ALLOCATE', 'Allocate', 'startWorkflow', wfFailureReason ?? 'Resident cost allocation failed.'));
    } else if (err) {
      out.push(failed('ALLOCATE', 'Allocate', 'getAllocationSummary', err));
    } else if (summary) {
      const requested = num(summary.totalRequestedQuantity);
      const allocated = num(summary.totalAllocatedQuantity);
      const residents = num(summary.residentCount);
      out.push({
        stage: 'ALLOCATE',
        label: 'Allocate',
        state: 'verified',
        summary:
          requested !== null && allocated !== null
            ? `${allocated} of ${requested} units allocated to resident orders.`
            : 'Community procurement allocated to resident orders.',
        facts: [
          ...(residents !== null ? [{ label: 'Resident orders', value: String(residents) }] : []),
          ...(requested !== null && allocated !== null
            ? [{ label: 'Allocated', value: `${allocated} / ${requested}` }]
            : []),
        ],
        source: 'getAllocationSummary',
      });
    } else if (wfProgressed('ALLOCATE')) {
      out.push({
        stage: 'ALLOCATE',
        label: 'Allocate',
        state: 'verified',
        summary: 'Resident allocation completed per engine progress record.',
        facts: wfProgressFacts('ALLOCATE'),
        source: 'getWorkflowState',
      });
    } else {
      out.push(absent('ALLOCATE', 'Allocate', 'No allocation evidence in this run.'));
    }
  }
  if (!wf) {
    const r = tools.get('allocateResidentOrders');
    const err = toolErrors.get('allocateResidentOrders');
    if (err || (r && r.success === false)) {
      out.push(failed('ALLOCATE', 'Allocate', 'allocateResidentOrders', err ?? 'Allocation failed.'));
    } else if (r) {
      const count = num(r.allocationsCount);
      out.push({
        stage: 'ALLOCATE',
        label: 'Allocate',
        state: 'verified',
        summary:
          count !== null
            ? `${count} allocation${count === 1 ? '' : 's'} posted back to resident orders.`
            : 'Community procurement allocated to resident orders.',
        facts: count !== null ? [{ label: 'Allocations', value: String(count) }] : [],
        source: 'allocateResidentOrders',
      });
    } else {
      out.push(absent('ALLOCATE', 'Allocate', 'No allocation evidence in this run.'));
    }
  }

  // 12. RECONCILE
  if (wf) {
    const state = tools.get('getWorkflowState') || tools.get('startWorkflow');
    const data = asRecord(state?.data) || state;
    const proof = asRecord(data?.financialProof);
    const r = tools.get('getReconciliationStatus') || asRecord(proof?.reconciliation);
    const err = toolErrors.get('getReconciliationStatus');
    if (failedWorkflowStage === 'RECONCILE') {
      out.push(failed('RECONCILE', 'Reconcile', 'startWorkflow', wfFailureReason ?? 'Order reconciliation failed.'));
    } else if (err) {
      out.push(failed('RECONCILE', 'Reconcile', 'getReconciliationStatus', err));
    } else if (r) {
      const qp = r.isQuantityMatched === true;
      const fp = r.isMonetaryMatched === true;
      const sp = r.isSupplierObligationsMatched === true;
      const pp = r.isPaymentVerified === true;
      const status = str(r.status);
      const openCount =
        num(r.discrepancyCount) ??
        (Array.isArray(r.discrepancies) ? r.discrepancies.length : 0);
      const checks: StageFact[] = [
        { label: 'Quantity', value: qp ? 'passed' : 'FAILED' },
        { label: 'Financial', value: fp ? 'passed' : 'FAILED' },
        { label: 'Supplier obligations', value: sp ? 'passed' : 'FAILED' },
        { label: 'Payment', value: pp ? 'passed' : 'FAILED' },
      ];
      const ok = status === 'RECONCILED' && qp && fp && sp && pp && openCount === 0;
      out.push({
        stage: 'RECONCILE',
        label: 'Reconcile',
        state: ok ? 'verified' : 'failed',
        summary: ok
          ? 'All reconciliation checks passed with zero discrepancy.'
          : `Reconciliation did not pass (status: ${status ?? 'unknown'}).`,
        facts: checks,
        source: 'getReconciliationStatus',
      });
    } else if (wfProgressed('RECONCILE')) {
      out.push({
        stage: 'RECONCILE',
        label: 'Reconcile',
        state: 'verified',
        summary: 'Reconciliation completed per engine progress record.',
        facts: wfProgressFacts('RECONCILE'),
        source: 'getWorkflowState',
      });
    } else {
      out.push(absent('RECONCILE', 'Reconcile', 'No reconciliation evidence in this run.'));
    }
  }
  if (!wf) {
    const r = tools.get('reconcileOrder');
    const err = toolErrors.get('reconcileOrder');
    const fcRecon = fullCycle?.reconciliation ?? null;
    const status = str(r?.status) ?? fcRecon?.status ?? null;
    const reconciled = (r?.isReconciled ?? fcRecon?.isReconciled) === true;
    if (err || (r && r.success === false)) {
      out.push(failed('RECONCILE', 'Reconcile', 'reconcileOrder', err ?? 'Reconciliation failed.'));
    } else if (r || fcRecon) {
      const qp = (r?.quantityPassed ?? fcRecon?.quantityReconciliation.passed) === true;
      const fp = (r?.financialPassed ?? fcRecon?.financialReconciliation.passed) === true;
      const pp = (r?.productPassed ?? fcRecon?.productIntegrity.passed) === true;
      const sp = (r?.societyPassed ?? fcRecon?.societyIntegrity.passed) === true;
      const checks: StageFact[] = [
        { label: 'Quantity', value: qp ? 'passed' : 'FAILED' },
        { label: 'Financial', value: fp ? 'passed' : 'FAILED' },
        { label: 'Product', value: pp ? 'passed' : 'FAILED' },
        { label: 'Society', value: sp ? 'passed' : 'FAILED' },
      ];
      const ok = reconciled && status !== 'FAILED' && qp && fp && pp && sp;
      out.push({
        stage: 'RECONCILE',
        label: 'Reconcile',
        state: ok ? 'verified' : 'failed',
        summary: ok
          ? 'All four reconciliation pillars passed with zero discrepancy.'
          : `Reconciliation did not pass (status: ${status ?? 'unknown'}).`,
        facts: checks,
        source: fcRecon ? 'execution/full-cycle' : 'reconcileOrder',
      });
    } else {
      out.push(absent('RECONCILE', 'Reconcile', 'No reconciliation evidence in this run.'));
    }
  }

  // 13. COMPLETE
  {
    const anyFailed = out.some((s) => s.state === 'failed');
    if (run.status === 'failed') {
      out.push(
        failed(
          'COMPLETE',
          'Complete',
          null,
          run.error?.message ?? 'Procurement run failed.'
        )
      );
    } else if (run.status === 'complete' && !anyFailed) {
      out.push({
        stage: 'COMPLETE',
        label: 'Complete',
        state: 'verified',
        summary: 'Procurement complete. Every verified stage above cites backend evidence.',
        facts: [],
        source: null,
      });
    } else if (anyFailed) {
      const names = out
        .filter((s) => s.state === 'failed')
        .map((s) => s.label)
        .join(', ');
      out.push(failed('COMPLETE', 'Complete', null, `Blocked by failed stages: ${names}.`));
    } else {
      out.push(absent('COMPLETE', 'Complete', 'Run has not completed.'));
    }
  }

  return out;
}
