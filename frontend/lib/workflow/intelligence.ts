import { formatMoney, formatQuantity } from '@/lib/format';
import type { CanonicalStage, StageEvidence } from '@/lib/workflow/stageEvidence';
import type { ProcurementRun } from '@/lib/workflow/types';
import {
  getCommitmentEvidence,
  getFulfillmentEvidence,
  getIntentEvidence,
  getNegotiationEvidence,
  getPaymentEvidence,
  getQuoteEvidence,
  getReconEvidence,
  getSupplierEvidence,
} from '@/lib/workflow/runEvidence';

/**
 * Relay Intelligence: concise decision-relevant explanations derived ONLY from
 * backend evidence. Never chain-of-thought, never invented.
 */

export interface IntelligenceNote {
  stage: CanonicalStage;
  title: string;
  lines: string[];
}

export function getRunIntelligence(run: ProcurementRun): IntelligenceNote[] {
  const notes: IntelligenceNote[] = [];

  const intent = getIntentEvidence(run);
  if (intent) {
    const lines: string[] = [];
    if (intent.items && intent.items.length > 1) {
      const itemSummaries = intent.items.map(
        (it) => `${it.quantity !== null ? formatQuantity(it.quantity, it.unit ?? undefined) : ''} ${it.productName}`.trim()
      );
      lines.push(`${itemSummaries.join(', ')} identified from your request.`);
    } else if (intent.productName && intent.quantity !== null) {
      lines.push(
        `${formatQuantity(intent.quantity, intent.unit ?? undefined)} ${intent.productName} identified from your request.`
      );
    }
    if (intent.requestedAmount !== null && intent.maxAllowed !== null) {
      if (intent.requestedAmount <= intent.maxAllowed) {
        lines.push(
          `Estimated ${formatMoney(intent.requestedAmount)} fits inside the ${formatMoney(intent.maxAllowed)} mandate — cleared for autonomous execution.`
        );
      } else {
        lines.push(
          `Estimated ${formatMoney(intent.requestedAmount)} exceeds the ${formatMoney(intent.maxAllowed)} mandate — blocked by mandate authorization.`
        );
      }
    }
    if (intent.groupsCount !== null && intent.groupsCount > 1) {
      lines.push(
        `Community demand pools across ${intent.groupsCount} product groups — procurement will ride the pooled batch.`
      );
    }
    if (lines.length > 0) notes.push({ stage: 'UNDERSTAND', title: 'Intent', lines });
  }

  const suppliers = getSupplierEvidence(run);
  if (suppliers) {
    const lines: string[] = [];
    if (suppliers.qualifiedCount !== null) {
      lines.push(`${suppliers.qualifiedCount} suppliers satisfy the hard constraints.`);
    }
    const excluded = suppliers.suppliers.filter((s) => s.eligible === false);
    for (const s of excluded.slice(0, 2)) {
      lines.push(
        `${s.supplierName} ruled out${s.reasons.length > 0 ? `: ${s.reasons[0]}` : ''}.`
      );
    }
    if (lines.length > 0) {
      notes.push({ stage: 'DISCOVER', title: 'Supplier reasoning', lines });
    }
  }

  const quotes = getQuoteEvidence(run);
  if (quotes && quotes.offers.length > 0) {
    const eligible = quotes.offers.filter((o) => o.eligible !== false);
    const lines: string[] = [];
    if (eligible.length > 0) {
      // Backend backing required: the backend-selected winner, or legacy
      // backend composite scores. Engine offers carry no scores, so sorting
      // them would falsely crown whichever quote arrived first — say nothing
      // instead.
      const selected = eligible.find((o) => o.selected);
      const hasScores = eligible.some((o) => o.compositeScore !== null);
      const best =
        selected ??
        (hasScores
          ? [...eligible].sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0))[0]
          : null);
      if (best) {
        lines.push(
          `${best.supplierName} offers the strongest price/SLA tradeoff across ${eligible.length} eligible quotes.`
        );
      }
    }
    if (quotes.selectedSupplierName) {
      lines.push(`${quotes.selectedSupplierName} is the strongest eligible candidate.`);
    }
    if (quotes.commercialBasisSimulated) {
      lines.push('Commercial basis: simulated supplier quotes for local demonstration.');
    }
    notes.push({ stage: 'SELECT', title: 'Quote interpretation', lines });
  }

  const negotiation = getNegotiationEvidence(run);
  if (negotiation) {
    notes.push({
      stage: 'NEGOTIATE',
      title: 'Negotiation',
      lines: [
        `Community volume created negotiation leverage across ${negotiation.rounds.length} recorded steps.`,
      ],
    });
  }

  const commitment = getCommitmentEvidence(run);
  if (commitment && commitment.totalAmount !== null) {
    const lines = [
      `Purchase commitment locked at ${formatMoney(commitment.totalAmount)} — Relay validates the exact amount.`,
    ];
    if (commitment.commercialBasisSimulated) {
      lines.push('Commercial terms based on simulated supplier responses for hackathon demo.');
    }
    notes.push({
      stage: 'COMMIT',
      title: 'Commitment',
      lines,
    });
  }

  const payment = getPaymentEvidence(run);
  if (payment && payment.amount !== null) {
    notes.push({
      stage: 'PAY',
      title: 'Payment',
      lines: [
        `${formatMoney(payment.amount, payment.currency)} settled under mandate authorization (${payment.status ?? 'recorded'}).`,
      ],
    });
  }

  const fulfillment = getFulfillmentEvidence(run);
  if (fulfillment && fulfillment.status) {
    notes.push({
      stage: 'FULFILL',
      title: 'Fulfillment',
      lines: [
        fulfillment.status === 'DELIVERED'
          ? `Delivered and confirmed${fulfillment.trackingCode ? ` · ${fulfillment.trackingCode}` : ''}.`
          : `Fulfillment state: ${fulfillment.status.toLowerCase().replace(/_/g, ' ')}.`,
      ],
    });
  }

  const recon = getReconEvidence(run);
  if (recon) {
    // The workflow engine reports quantity/monetary/supplier/payment checks
    // rather than the mock chain's product/society pillars; judge each run by
    // its own vocabulary.
    const ok =
      recon.source === 'workflow-engine'
        ? recon.isReconciled === true &&
          recon.status === 'RECONCILED' &&
          recon.quantity.passed === true &&
          recon.financial.passed === true
        : recon.isReconciled === true &&
          recon.status === 'RECONCILED' &&
          recon.quantity.passed === true &&
          recon.financial.passed === true &&
          recon.productPassed === true &&
          recon.societyPassed === true;
    notes.push({
      stage: 'RECONCILE',
      title: 'Reconciliation',
      lines: ok
        ? [
            `Every pillar balances — reported discrepancy ₹${recon.financial.difference ?? '?'} / qty ${recon.quantity.difference ?? '?'}.`,
          ]
        : [`Reconciliation verdict: ${recon.status ?? 'not confirmed'} — inspect discrepancies.`],
    });
  }

  return notes;
}

export function getStageIntelligence(
  stage: CanonicalStage,
  run: ProcurementRun
): string[] {
  const note = getRunIntelligence(run).find((n) => n.stage === stage);
  return note?.lines ?? [];
}

export function summarizeRunOutcome(stages: StageEvidence[]): {
  verified: number;
  failed: number;
  absent: number;
} {
  return {
    verified: stages.filter((s) => s.state === 'verified').length,
    failed: stages.filter((s) => s.state === 'failed').length,
    absent: stages.filter((s) => s.state === 'absent').length,
  };
}
