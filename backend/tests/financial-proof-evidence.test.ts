/**
 * Final hardening — authoritative financial proof rides on engine state
 * results (startWorkflow/getWorkflowState), never on whichever detail
 * getters the model happened to call.
 *
 * Pins: financialProof presence + value-equality with the detail getters,
 * requested-vs-guaranteed SLA disclosure, and exact Decimal paidAmount sums.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  startWorkflowTool,
  getWorkflowStateTool,
  getProcurementCommitmentTool,
  getProcurementPaymentSummaryTool,
  getAllocationSummaryTool,
  getReconciliationStatusTool,
  getFulfillmentStateTool,
} from '../src/agent/tools/definitions';
import { resolveWorkflowRequest } from '../src/agent/intent/resolveWorkflowItems';
import { OPERATIONAL_SLA_HOURS } from '../src/orchestration/sla';
import { relayOrchestrator } from '../src/orchestration';
import {
  paymentService as defaultPaymentService,
  mandateService as defaultMandateService,
  mockPaymentProvider as defaultMockProvider,
} from '../src/payment';
import {
  procurementCommitmentService as defaultCommitmentService,
  purchaseOrderService as defaultPOService,
  rfqService as defaultRfqService,
  quoteNormalizationService as defaultQuoteService,
} from '../src/discovery/supplier';
import { RFQService } from '../src/discovery/supplier/rfq/RFQService';
import { SupplierResponseService } from '../src/discovery/supplier/quote/provider/SupplierResponseService';
import { QuoteNormalizationService } from '../src/discovery/supplier/quote/QuoteNormalizationService';
import { MockSupplierResponseProvider } from '../src/discovery/supplier/quote/provider/MockSupplierResponseProvider';
import { SupplierCandidate } from '../src/discovery/supplier/types';

const CTX = {} as never;

let mandateCounter = 0;

/**
 * Starts a workflow whose resident holds a REAL mandate created through
 * the mandate service. Relay never auto-creates mandate consent, so a
 * workflow that must reach PAY needs this explicit fixture.
 */
async function startWithMandate(requestText = 'I need 2 kg sugar.') {
  mandateCounter += 1;
  const residentReference = `res_finproof_${mandateCounter}`;
  const societyReference = 'soc_greenview_pune';
  defaultMandateService.createMandate({
    ownerReference: residentReference,
    purpose: 'COMMUNITY_PROCUREMENT',
    spendingLimit: 1000000,
    currency: 'INR',
  });
  return startWorkflowTool.execute(
    { requestText, residentReference, societyReference },
    { residentId: residentReference, societyId: societyReference } as never,
  );
}

/** Server execution context for the workflow's owning resident. */
function ctxFor(workflowId: string) {
  const wf = relayOrchestrator.getWorkflow(workflowId)!;
  return { residentId: wf.residentReference, societyId: wf.societyReference } as never;
}

describe('Financial proof evidence block', () => {
  beforeEach(() => {
    defaultRfqService.reset();
    defaultQuoteService.reset();
    defaultCommitmentService.reset();
    defaultPOService.reset();
    defaultPaymentService.reset();
    defaultMandateService.reset();
    defaultMockProvider.reset();
  });

  it('startWorkflow attaches a complete financialProof snapshot without any detail getter call', async () => {
    const result = await startWithMandate();
    expect(result.success).toBe(true);
    expect(result.data.status).toBe('COMPLETED');

    const proof = result.data.financialProof as Record<string, unknown>;
    expect(proof).toBeDefined();
    const workflowId = (result.data as any).workflowId as string;
    const state = await getWorkflowStateTool.execute({ workflowId }, ctxFor(workflowId));
    const entities = (state.data as any).entities as Record<string, unknown>;

    const commitment = proof.commitment as Record<string, any>;
    expect(commitment.id).toBe(entities.commitmentId);
    expect(commitment.financials.total).toBeGreaterThan(0);

    const payment = proof.payment as Record<string, any>;
    expect(payment.id).toBe(entities.paymentId);
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.amount).toBe(commitment.financials.total);

    const summary = proof.paymentSummary as Record<string, any>;
    expect(summary.status).toBe('FULLY_PAID');
    expect(summary.paidAmount).toBe(commitment.financials.total);

    const allocation = proof.allocation as Record<string, any>;
    expect(allocation.totalProcurementCost).toBe(commitment.financials.total);
    expect(allocation.totalResidentAllocatedAmount).toBe(commitment.financials.total);

    const reconciliation = proof.reconciliation as Record<string, any>;
    expect(reconciliation.status).toBe('RECONCILED');
    expect(reconciliation.isQuantityMatched).toBe(true);
    expect(reconciliation.isMonetaryMatched).toBe(true);
    expect(reconciliation.isPaymentVerified).toBe(true);
    expect(reconciliation.discrepancies).toEqual([]);

    const fulfillment = proof.fulfillment as Record<string, any>;
    expect(fulfillment.id).toBe((entities.fulfillmentOrderIds as string[])[0]);
    expect(['DELIVERED', 'VERIFIED']).toContain(fulfillment.status);
  });

  it('financialProof values equal the detail getters’ values for the same run', async () => {
    const started = await startWithMandate();
    const workflowId = (started.data as any).workflowId as string;
    const state = await getWorkflowStateTool.execute({ workflowId }, ctxFor(workflowId));
    const proof = (state.data as any).financialProof as Record<string, any>;
    const entities = (state.data as any).entities as Record<string, string>;

    const commitmentRes: any = await getProcurementCommitmentTool.execute(
      { commitmentId: entities.commitmentId },
      CTX
    );
    expect(proof.commitment).toEqual(commitmentRes.commitment);

    const summaryRes: any = await getProcurementPaymentSummaryTool.execute(
      { commitmentId: entities.commitmentId },
      ctxFor(workflowId)
    );
    expect(proof.paymentSummary.paidAmount).toBe(summaryRes.summary.paidAmount);
    expect(proof.paymentSummary.status).toBe(summaryRes.summary.status);

    const allocRes: any = await getAllocationSummaryTool.execute(
      { commitmentId: entities.commitmentId },
      ctxFor(workflowId)
    );
    expect(proof.allocation.totalProcurementCost).toBe(allocRes.totalProcurementCost);
    expect(proof.allocation.totalResidentAllocatedAmount).toBe(
      allocRes.totalResidentAllocatedAmount
    );

    const reconRes: any = await getReconciliationStatusTool.execute(
      { commitmentId: entities.commitmentId },
      ctxFor(workflowId)
    );
    expect(proof.reconciliation.status).toBe(reconRes.status);
    expect(proof.reconciliation.isMonetaryMatched).toBe(reconRes.isMonetaryMatched);

    const fulfRes: any = await getFulfillmentStateTool.execute(
      { fulfillmentId: (entities.fulfillmentOrderIds as unknown as string[])[0] },
      CTX
    );
    expect(proof.fulfillment).toEqual(fulfRes.order);
  });

  it('getWorkflowState carries financialProof and the SLA disclosure block', async () => {
    const started = await startWorkflowTool.execute(
      { requestText: 'I need 2 kg sugar within 8 hours.' },
      CTX
    );
    const workflowId = (started.data as any).workflowId as string;
    const state = await getWorkflowStateTool.execute({ workflowId }, ctxFor(workflowId));

    expect((state.data as any).financialProof.commitment).toBeDefined();
    expect((state.data as any).sla).toEqual({
      requestedHours: 8,
      operationalGuaranteeHours: OPERATIONAL_SLA_HOURS,
    });
    expect(OPERATIONAL_SLA_HOURS).toBe(12);
  });

  it('resolveWorkflowRequest surfaces the validated deadline without changing items', async () => {
    const withDeadline = await resolveWorkflowRequest('I need 2 kg sugar within 8 hours.');
    expect(withDeadline.deadlineHours).toBe(8);
    expect(withDeadline.items).toHaveLength(1);
    expect(withDeadline.items[0].productName).toMatch(/sugar/i);

    const withoutDeadline = await resolveWorkflowRequest('I need 2 kg sugar.');
    expect(withDeadline.items).toHaveLength(1);
    expect(withoutDeadline.deadlineHours).toBeUndefined();
    expect(withoutDeadline.items[0].quantity).toBe(2);
  });

  it('payment summary paidAmount is an exact Decimal sum, not float accumulation', async () => {
    // Default singletons: the commitment service resolves RFQs/quotes
    // through its own injected instances (same as payment-execution tests).
    const rfqService = defaultRfqService;
    const quoteNormalizationService = defaultQuoteService;
    const supplierResponseService = new SupplierResponseService(rfqService);
    supplierResponseService.registerProvider(new MockSupplierResponseProvider(rfqService));

    const cand = (id: string, name: string): SupplierCandidate => ({
      id,
      name,
      address: 'Exact Market, Pune',
      latitude: 18.5,
      longitude: 73.85,
      categories: ['commercial.supermarket'],
      email: `${id}@example.com`,
    });
    const now = new Date();
    const mkQuote = async (candidate: SupplierCandidate, unitPrice: number) => {
      const rfq = await rfqService.createRFQ({
        candidate,
        lineItems: [{ productName: 'Paise Spice', quantity: 2, unit: 'KG' as never }],
        deliveryArea: 'Greenview Residency',
        deliveryDeadline: new Date(now.getTime() + 12 * 3600 * 1000),
        quoteDeadline: new Date(now.getTime() + 4 * 3600 * 1000),
      });
      const resp = await supplierResponseService.ingestResponse({
        rfqId: rfq.id,
        candidateId: candidate.id,
        supplierName: candidate.name,
        channel: 'manual',
        lineItems: [
          { productName: 'Paise Spice', quotedQuantity: 1, unit: 'KG', unitPrice },
        ],
        deliveryFee: 0,
        deliveryEtaHours: 6,
        validUntil: new Date(now.getTime() + 24 * 3600 * 1000),
      });
      return { rfq, quote: (await quoteNormalizationService.normalizeResponse(resp)).quote };
    };

    // Totals 0.10 + 0.20: float accumulation prints 0.30000000000000004.
    const a = await mkQuote(cand('cand_exact_a', 'Exact A'), 0.1);
    const b = await mkQuote(cand('cand_exact_b', 'Exact B'), 0.2);

    const split = await defaultCommitmentService.createCommitment({
      rfqId: a.rfq.id,
      recommendation: {
        decision: 'SPLIT_ORDER',
        allocations: [
          { supplierId: 'cand_exact_a', quoteId: a.quote.id, quantity: 1 },
          { supplierId: 'cand_exact_b', quoteId: b.quote.id, quantity: 1 },
        ],
        reason: 'Exactness probe split',
      },
    });

    const mandate = defaultMandateService.createMandate({
      ownerReference: 'res_exact_probe',
      purpose: 'COMMUNITY_PROCUREMENT',
      currency: 'INR',
      spendingLimit: 100000,
    });

    const { summary } = await defaultPaymentService.payCommitment({
      ownerReference: 'res_exact_probe',
      commitmentId: split.commitment.id,
      mandateId: mandate.id,
    });
    expect(summary.status).toBe('FULLY_PAID');
    expect(summary.paidAmount).toBe(0.3);
  });
});
