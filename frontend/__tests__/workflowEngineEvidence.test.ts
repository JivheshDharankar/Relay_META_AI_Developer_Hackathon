import { describe, expect, it } from 'vitest';
import { mapRunToStages } from '@/lib/workflow/stageEvidence';
import {
  getAllocationEvidence,
  getCommitmentEvidence,
  getFulfillmentEvidence,
  getIntentEvidence,
  getNegotiationEvidence,
  getPaymentEvidence,
  getQuoteEvidence,
  getReconEvidence,
  getSupplierEvidence,
} from '@/lib/workflow/runEvidence';
import { getRunIntelligence } from '@/lib/workflow/intelligence';
import { hasWorkflowEngine } from '@/lib/workflow/guards';
import { IDLE_RUN, type ProcurementRun } from '@/lib/workflow/types';
import type { AgentRunResponse } from '@/types';

/**
 * Phase 18.3 — workflow-engine (Meta path) evidence mapping.
 *
 * Fixture shapes below mirror REAL captured backend artifacts (field names,
 * nesting, and value types verified against live startWorkflow-driven runs).
 * They exist only to pin the mapping layer; the UI never ships fixture data.
 */

const THOUGHT_SENTINEL = 'zz-hidden-chain-of-thought-sentinel-zz';

function step(name: string, result: unknown, thought = THOUGHT_SENTINEL) {
  return {
    step: 1,
    thought,
    toolCall: { id: `call_${name}`, name, arguments: {}, result, durationMs: 5 },
  };
}

function errStep(name: string, code: string, message: string) {
  return {
    step: 1,
    thought: THOUGHT_SENTINEL,
    toolCall: {
      id: `call_${name}`,
      name,
      arguments: {},
      error: { code, message },
      durationMs: 5,
    },
  };
}

const WF_ID = 'wf_test_001';
const CANDIDATES = ['geo_cand_1', 'geo_cand_2', 'geo_cand_3'];
const QUALIFIED = ['geo_cand_1', 'geo_cand_2'];

function workflowResponse(overrides: { negotiated?: boolean; reconOk?: boolean } = {}): AgentRunResponse {
  const negotiated = overrides.negotiated ?? true;
  const reconOk = overrides.reconOk ?? true;
  return {
    success: true,
    runId: 'run-wf-001',
    response: 'done',
    steps: [
      // Exploratory mock-path failure the Meta loop recovered from: must not
      // shadow the engine outcome.
      errStep('createRequest', 'INVALID_REQUEST', 'Missing required productId'),
      step('startWorkflow', {
        success: true,
        workflowId: WF_ID,
        status: 'COMPLETED',
        currentStage: 'COMPLETE',
        version: 1,
      }),
      step('getWorkflowState', {
        success: true,
        data: {
          workflowId: WF_ID,
          status: 'COMPLETED',
          currentStage: 'COMPLETE',
          isPaused: false,
          entities: {
            residentReference: 'res_test',
            societyReference: 'soc_test',
            supplierCandidateIds: CANDIDATES,
            qualifiedSupplierIds: QUALIFIED,
            receivedQuoteIds: ['quote_a', 'quote_b'],
            negotiatedQuoteIds: negotiated ? ['quote_a'] : [],
            purchaseOrderIds: ['po_1'],
            fulfillmentOrderIds: ['ful_1'],
            deliveryTrackingCodes: ['TRK-1'],
            residentOrderId: 'ro_1',
            rfqId: 'rfq_1',
            selectedQuoteId: 'quote_a',
            commitmentId: 'commit_1',
            paymentId: 'pmt_1',
            allocationSummaryId: 'commit_1',
            reconciliationId: 'rec_1',
          },
        },
      }),
      step('compareQuotesForSelection', {
        success: true,
        rfqId: 'rfq_1',
        comparison: {
          rfqId: 'rfq_1',
          requestedQuantity: 5,
          unit: 'kg',
          quotes: [
            {
              quoteId: 'quote_a',
              candidateId: 'geo_cand_1',
              supplierName: 'Test Supplier A',
              unitPrice: 75.92,
              total: 468.58,
              deliveryFee: 70,
              deliveryEtaHours: 8,
              isEligible: true,
              isSimulated: true,
            },
            {
              quoteId: 'quote_b',
              candidateId: 'geo_cand_2',
              supplierName: 'Test Supplier B',
              unitPrice: 90,
              total: 540,
              deliveryFee: 80,
              deliveryEtaHours: 9,
              isEligible: true,
              isSimulated: true,
            },
          ],
          eligibleQuotes: [{ quoteId: 'quote_a' }, { quoteId: 'quote_b' }],
        },
      }),
      step('getProcurementCommitment', {
        success: true,
        commitment: {
          id: 'commit_1',
          rfqId: 'rfq_1',
          selectedQuoteIds: ['quote_a'],
          supplierIds: ['geo_cand_1'],
          product: { productName: 'maida', unit: 'kg' },
          requestedQuantity: 5,
          committedQuantity: 5,
          allocations: [
            {
              id: 'alloc_1',
              commitmentId: 'commit_1',
              supplierId: 'geo_cand_1',
              supplierName: 'Test Supplier A',
              quoteId: 'quote_a',
              allocatedQuantity: 5,
              unit: 'kg',
              agreedUnitPrice: 75.92,
              lineSubtotal: 379.6,
              deliveryFee: 70,
              tax: 18.98,
              otherCharges: 0,
              totalAmount: 468.58,
              deliveryEtaHours: 8,
            },
          ],
          financials: {
            subtotal: 379.6,
            deliveryFee: 70,
            tax: 18.98,
            otherCharges: 0,
            total: 468.58,
            currency: 'INR',
          },
          deliveryDeadline: '2026-11-02T10:00:00.000Z',
          status: 'PAID',
          purchaseOrderIds: ['po_1'],
          commercialBasisSimulated: true,
          committedAt: '2026-11-01T10:00:00.000Z',
        },
      }),
      step('getReconciliationStatus', {
        success: true,
        commitmentId: 'commit_1',
        status: reconOk ? 'RECONCILED' : 'MISMATCH',
        isQuantityMatched: true,
        isMonetaryMatched: reconOk,
        isSupplierObligationsMatched: true,
        isPaymentVerified: reconOk,
        discrepancyCount: reconOk ? 0 : 1,
        discrepancies: reconOk ? [] : ['monetary mismatch'],
      }),
      step('getAllocationSummary', {
        success: true,
        commitmentId: 'commit_1',
        status: 'FINALIZED',
        reconciliationStatus: reconOk ? 'RECONCILED' : 'MISMATCH',
        totalRequestedQuantity: 5,
        totalAllocatedQuantity: 5,
        totalProcurementCost: 468.58,
        totalResidentAllocatedAmount: 468.58,
        residentCount: 1,
      }),
      step('getFulfillmentState', {
        success: true,
        order: {
          id: 'ful_1',
          commitmentId: 'commit_1',
          purchaseOrderId: 'po_1',
          paymentId: 'pmt_1',
          supplierId: 'geo_cand_1',
          supplierName: 'Test Supplier A',
          fulfillmentType: 'PHYSICAL_GOODS',
          status: 'VERIFIED',
          productName: 'maida',
          requestedQuantity: 5,
          fulfilledQuantity: 5,
          remainingQuantity: 0,
          unit: 'kg',
          commercialBasisSimulated: true,
          trackingReference: 'TRK-1',
          actualDeliveryAt: '2026-11-01T10:00:00.000Z',
          verifiedAt: '2026-11-01T10:00:00.000Z',
          verificationEvidence: { evidenceType: 'DELIVERY_CONFIRMATION' },
        },
      }),
    ],
  } as unknown as AgentRunResponse;
}

function mockResponse(): AgentRunResponse {
  return {
    success: true,
    runId: 'run-mock-001',
    response: 'done',
    steps: [
      step('createRequest', {
        success: true,
        orderId: 'ord_1',
        productId: 'prod_sugar',
        productName: 'Cane Sugar',
        quantity: 3,
        unit: 'KG',
        totalAmount: 120,
      }),
      step('checkAuthorization', {
        success: true,
        authorized: true,
        code: 'AUTHORIZED',
        maxAllowed: 8000,
        requestedAmount: 120,
      }),
      step('aggregateDemand', { success: true, societyId: 'soc_1', groupsCount: 2 }),
      step('discoverSuppliers', {
        success: true,
        eligibleCount: 2,
        qualifiedCount: 2,
        suppliers: [
          {
            supplierId: 'sup_1',
            supplierName: 'Mock Supplier',
            eligible: true,
            distanceKm: 5,
            serviceRadiusKm: 20,
            deliverySlaHours: 8,
            reasons: [],
          },
        ],
      }),
      step('evaluateOffers', {
        success: true,
        rankedOffers: [
          {
            supplierId: 'sup_1',
            supplierName: 'Mock Supplier',
            totalPrice: 126,
            deliveryHours: 6,
            reliabilityScore: 0.96,
            compositeScore: 0.88,
            eligible: true,
          },
        ],
      }),
      step('selectOffer', {
        success: true,
        supplierId: 'sup_1',
        supplierName: 'Mock Supplier',
        totalPrice: 126,
        compositeScore: 0.88,
        deliveryHours: 6,
      }),
      step('createCommunityOrder', {
        success: true,
        order: { id: 'comm_1', status: 'CREATED', totalAmount: 126, itemsCount: 1 },
      }),
      step('allocateResidentOrders', {
        success: true,
        communityOrderId: 'comm_1',
        deliveryId: 'del_1',
        allocationsCount: 1,
      }),
      step('reconcileOrder', {
        success: true,
        isReconciled: true,
        status: 'RECONCILED',
        quantityPassed: true,
        financialPassed: true,
        productPassed: true,
        societyPassed: true,
        discrepancies: [],
      }),
    ],
  } as unknown as AgentRunResponse;
}

function runWith(response: AgentRunResponse | null, status: ProcurementRun['status'] = 'complete'): ProcurementRun {
  return { ...IDLE_RUN, status, prompt: 'test', agentResponse: response };
}

describe('Phase 18.3 — workflow-engine evidence mapping', () => {
  it('detects the engine path only when startWorkflow succeeded', () => {
    expect(hasWorkflowEngine(workflowResponse())).toBe(true);
    expect(hasWorkflowEngine(mockResponse())).toBe(false);
    expect(hasWorkflowEngine(null)).toBe(false);
    const failedStart = {
      success: false,
      runId: 'x',
      response: 'no',
      steps: [errStep('startWorkflow', 'IDENTITY_REFERENCE_MISMATCH', 'rejected')],
    } as unknown as AgentRunResponse;
    expect(hasWorkflowEngine(failedStart)).toBe(false);
  });

  it('maps a completed engine run to 13 verified stages', () => {
    const stages = mapRunToStages(runWith(workflowResponse()));
    expect(stages).toHaveLength(13);
    expect(stages.map((s) => s.state)).toEqual(Array(13).fill('verified'));
    expect(stages[12].stage).toBe('COMPLETE');
  });

  it('verifies all 13 from the engine progress record when read-backs are sparse', () => {
    const stages13 = [
      'UNDERSTAND',
      'DISCOVER',
      'QUALIFY',
      'QUOTE',
      'NEGOTIATE',
      'SELECT',
      'COMMIT',
      'PAY',
      'FULFILL',
      'VERIFY',
      'ALLOCATE',
      'RECONCILE',
      'COMPLETE',
    ];
    const sparse = {
      success: true,
      runId: 'run-wf-sparse',
      response: 'done',
      steps: [
        step('startWorkflow', { success: true, workflowId: 'wf_sparse' }),
        step('getWorkflowState', {
          success: true,
          data: {
            entities: {
              supplierCandidateIds: ['a'],
              qualifiedSupplierIds: ['a'],
              receivedQuoteIds: [],
              negotiatedQuoteIds: [],
              paymentId: 'pmt_sparse',
            },
            progress: stages13.map((stage) => ({
              stage,
              label: stage,
              status: 'COMPLETED',
              completedAt: '2026-11-01T10:00:00.000Z',
            })),
          },
        }),
      ],
    } as unknown as AgentRunResponse;
    const stages = mapRunToStages(runWith(sparse));
    expect(stages.map((s) => s.state)).toEqual(Array(13).fill('verified'));
    const fulfill = stages.find((s) => s.stage === 'FULFILL')!;
    expect(fulfill.summary).toContain('per engine progress record');
    expect(fulfill.source).toBe('getWorkflowState');
  });

  it('keeps COMPLETE verified when negotiation is honestly absent', () => {
    const stages = mapRunToStages(runWith(workflowResponse({ negotiated: false })));
    const byStage = Object.fromEntries(stages.map((s) => [s.stage, s.state]));
    expect(byStage.NEGOTIATE).toBe('absent');
    expect(byStage.COMPLETE).toBe('verified');
    expect(byStage.RECONCILE).toBe('verified');
  });

  it('exploratory mock-tool errors do not shadow the engine outcome', () => {
    const stages = mapRunToStages(runWith(workflowResponse()));
    const understand = stages.find((s) => s.stage === 'UNDERSTAND')!;
    expect(understand.state).toBe('verified');
    expect(understand.source).toBe('startWorkflow');
    expect(understand.summary).toContain('maida');
  });

  it('fails RECONCILE honestly when the engine reports a mismatch', () => {
    const stages = mapRunToStages(runWith(workflowResponse({ reconOk: false })));
    const byStage = Object.fromEntries(stages.map((s) => [s.stage, s.state]));
    expect(byStage.RECONCILE).toBe('failed');
    expect(byStage.COMPLETE).toBe('failed');
    const recon = stages.find((s) => s.stage === 'RECONCILE')!;
    expect(recon.facts.find((f) => f.label === 'Financial')?.value).toBe('FAILED');
  });

  it('builds four equal pillars and a backend ₹0.00 discrepancy', () => {
    const recon = getReconEvidence(runWith(workflowResponse()))!;
    expect(recon.status).toBe('RECONCILED');
    expect(recon.isReconciled).toBe(true);
    expect(recon.source).toBe('workflow-engine');
    expect(recon.pillars.map((p) => p.label)).toEqual([
      'Community demand',
      'Supplier PO',
      'Provider debit',
      'Resident allocations',
    ]);
    expect(recon.pillars.map((p) => p.value)).toEqual(['468.58', '468.58', '468.58', '468.58']);
    expect(recon.financial.difference).toBe('0.00');
    expect(recon.quantity.difference).toBe('0');
  });

  it('extracts supplier, quote, payment, fulfillment, allocation evidence verbatim', () => {
    const run = runWith(workflowResponse());
    const suppliers = getSupplierEvidence(run)!;
    expect(suppliers.eligibleCount).toBe(3);
    expect(suppliers.qualifiedCount).toBe(2);
    const quotes = getQuoteEvidence(run)!;
    expect(quotes.offers).toHaveLength(2);
    expect(quotes.selectedSupplierName).toBe('Test Supplier A');
    expect(quotes.offers.find((o) => o.selected)?.supplierName).toBe('Test Supplier A');
    expect(quotes.productName).toBe('maida');
    expect(quotes.quantity).toBe(5);
    const payment = getPaymentEvidence(run)!;
    expect(payment.providerReference).toBe('pmt_1');
    expect(payment.status).toBe('PAID');
    expect(payment.amount).toBe(468.58);
    expect(payment.source).toBe('workflow-engine');
    const fulfillment = getFulfillmentEvidence(run)!;
    expect(fulfillment.status).toBe('VERIFIED');
    expect(fulfillment.trackingCode).toBe('TRK-1');
    expect(fulfillment.poReference).toBe('po_1');
    const allocation = getAllocationEvidence(run)!;
    expect(allocation.allocationsCount).toBe(1);
    const commitment = getCommitmentEvidence(run)!;
    expect(commitment.id).toBe('commit_1');
    expect(commitment.totalAmount).toBe(468.58);
    const intent = getIntentEvidence(run)!;
    expect(intent.productName).toBe('maida');
    expect(intent.quantity).toBe(5);
    expect(getNegotiationEvidence(run)?.rounds).toHaveLength(1);
  });

  it('marks simulated commercial basis from the backend record', () => {
    const stages = mapRunToStages(runWith(workflowResponse()));
    const quote = stages.find((s) => s.stage === 'QUOTE')!;
    expect(quote.facts.find((f) => f.label === 'Commercial basis')?.value).toBe(
      'Simulated (per backend record)'
    );
  });

  it('fails UNDERSTAND honestly when startWorkflow is rejected', () => {
    const response = {
      success: false,
      runId: 'run-wf-err',
      response: 'Relay could not start the workflow: references must match.',
      steps: [errStep('startWorkflow', 'IDENTITY_REFERENCE_MISMATCH', 'references must match')],
    } as unknown as AgentRunResponse;
    const stages = mapRunToStages(runWith(response, 'failed'));
    const understand = stages.find((s) => s.stage === 'UNDERSTAND')!;
    expect(understand.state).toBe('failed');
    // No engine outcome exists, so the run renders the backend's own words.
    expect(understand.summary).toContain('references must match');
    expect(stages.filter((s) => s.state === 'verified')).toHaveLength(0);
  });

  it('keeps the mock vocabulary mapping intact', () => {
    const run = runWith(mockResponse());
    const stages = mapRunToStages(run);
    const byStage = Object.fromEntries(stages.map((s) => [s.stage, s.state]));
    expect(byStage.UNDERSTAND).toBe('verified');
    expect(byStage.DISCOVER).toBe('verified');
    expect(byStage.QUALIFY).toBe('verified');
    expect(byStage.QUOTE).toBe('verified');
    expect(byStage.SELECT).toBe('verified');
    expect(byStage.COMMIT).toBe('verified');
    expect(byStage.ALLOCATE).toBe('verified');
    expect(byStage.RECONCILE).toBe('verified');
    expect(byStage.COMPLETE).toBe('verified');
    expect(getQuoteEvidence(run)?.selectedSupplierName).toBe('Mock Supplier');
    expect(getReconEvidence(run)?.source).toBe('reconcileOrder');
  });

  it('derives workflow intelligence notes without chain-of-thought', () => {
    const notes = getRunIntelligence(runWith(workflowResponse()));
    const byStage = Object.fromEntries(notes.map((n) => [n.stage, n.lines.join(' ')]));
    expect(byStage.UNDERSTAND).toContain('maida');
    expect(byStage.RECONCILE).toContain('₹0.00');
    expect(JSON.stringify(notes)).not.toContain(THOUGHT_SENTINEL);
  });

  it('never leaks step.thought into mapped stages or evidence', () => {
    const run = runWith(workflowResponse());
    const blob = JSON.stringify({
      stages: mapRunToStages(run),
      recon: getReconEvidence(run),
      quotes: getQuoteEvidence(run),
      payment: getPaymentEvidence(run),
      fulfillment: getFulfillmentEvidence(run),
    });
    expect(blob).not.toContain(THOUGHT_SENTINEL);
  });
});

describe('Final polish — multi-item lines, provenance, negotiated winner', () => {
  // Mirrors a REAL captured multi-item run: commitment carries the primary
  // line plus the SUMMED quantity; per-item truth lives in quote lines.
  // NOTE: the run prompt deliberately omits the products — mapping must
  // come from backend artifacts, never prompt parsing.
  function multiItemResponse(): AgentRunResponse {
    return {
      success: true,
      runId: 'run-multi-001',
      response: 'done',
      steps: [
        step('startWorkflow', { success: true, workflowId: WF_ID, status: 'COMPLETED', currentStage: 'COMPLETE', version: 1 }),
        step('getWorkflowState', {
          success: true,
          data: {
            workflowId: WF_ID,
            status: 'COMPLETED',
            currentStage: 'COMPLETE',
            isPaused: false,
            entities: {
              residentReference: 'res_test',
              societyReference: 'soc_test',
              receivedQuoteIds: ['quote_a'],
              negotiatedQuoteIds: ['quote_a'],
              selectedQuoteId: 'quote_a',
              commitmentId: 'commit_1',
            },
          },
        }),
        step('getQuote', {
          success: true,
          quote: {
            id: 'quote_a',
            rfqId: 'rfq_1',
            candidateId: 'geo_cand_1',
            supplierName: 'Test Supplier A',
            status: 'VALID',
            isSimulated: true,
            lineItems: [
              { productName: 'rice', quotedQuantity: 2, unit: 'kg', unitPrice: 95.04, lineSubtotal: 190.08 },
              { productName: 'wheat', quotedQuantity: 3, unit: 'kg', unitPrice: 77.76, lineSubtotal: 233.28 },
            ],
            subtotal: 423.36,
            tax: 21.17,
            deliveryFee: 89,
            otherCharges: 0,
            total: 533.53,
          },
        }),
        step('getProcurementCommitment', {
          success: true,
          commitment: {
            id: 'commit_1',
            rfqId: 'rfq_1',
            selectedQuoteIds: ['quote_a'],
            supplierIds: ['geo_cand_1'],
            product: { productName: 'rice', unit: 'kg' },
            requestedQuantity: 5,
            committedQuantity: 5,
            allocations: [{ supplierId: 'geo_cand_1', supplierName: 'Test Supplier A', quoteId: 'quote_a', quantity: 5 }],
            financials: { subtotal: 423.36, deliveryFee: 89, tax: 21.17, otherCharges: 0, total: 533.53, currency: 'INR' },
            status: 'COMMITTED',
            commercialBasisSimulated: true,
          },
        }),
      ],
    } as unknown as AgentRunResponse;
  }

  it('reads per-item lines from quote artifacts, never the prompt', () => {
    const run = runWith(multiItemResponse());
    run.prompt = 'unrelated words with no product names';
    const intent = getIntentEvidence(run)!;
    expect(intent.items).toEqual([
      { productName: 'rice', quantity: 2, unit: 'kg' },
      { productName: 'wheat', quantity: 3, unit: 'kg' },
    ]);
    // Canonical multi-item behavior: items list preserved, joined product names, and scalar quantity is null to prevent heterogeneous summing
    expect(intent.productName).toBe('rice, wheat');
    expect(intent.quantity).toBeNull();
    expect(intent.unit).toBe('mixed');
  });

  it('Stage 01 summary lists every line instead of merging them', () => {
    const stages = mapRunToStages(runWith(multiItemResponse()));
    const understand = stages.find((s) => s.stage === 'UNDERSTAND')!;
    expect(understand.state).toBe('verified');
    expect(understand.summary).toContain('2 kg rice');
    expect(understand.summary).toContain('3 kg wheat');
    expect(understand.summary).not.toContain('5 kg');
    expect(understand.facts.filter((f) => f.label === 'Item')).toHaveLength(2);
  });

  it('single-line quotes keep the legacy single presentation', () => {
    const run = runWith(workflowResponse());
    expect(getIntentEvidence(run)?.items).toBeNull();
    const understand = mapRunToStages(run).find((s) => s.stage === 'UNDERSTAND')!;
    expect(understand.summary).toContain('5 kg maida');
  });

  it('exposes simulated provenance and the negotiated winning total', () => {
    const quotes = getQuoteEvidence(runWith(multiItemResponse()))!;
    expect(quotes.commercialBasisSimulated).toBe(true);
    expect(quotes.hasNegotiatedWinner).toBe(true);
    expect(quotes.winningTotal).toBe(533.53);
  });

  it('provenance stays null when the backend reports none', () => {
    const quotes = getQuoteEvidence(runWith(mockResponse()))!;
    expect(quotes.commercialBasisSimulated).toBeNull();
    expect(quotes.hasNegotiatedWinner).toBe(false);
    expect(quotes.winningTotal).toBeNull();
  });

  it('no negotiated winner when selection did not negotiate', () => {
    const quotes = getQuoteEvidence(runWith(workflowResponse({ negotiated: false })))!;
    expect(quotes.hasNegotiatedWinner).toBe(false);
  });
});
