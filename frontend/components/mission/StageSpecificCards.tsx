'use client';

import React from 'react';
import Link from 'next/link';
import {
  BrainCircuit,
  Search,
  CheckCircle,
  FileSpreadsheet,
  Handshake,
  Award,
  FileCheck,
  CreditCard,
  Truck,
  ShieldCheck,
  Split,
  Scale,
  ChevronRight,
  Clock,
  Shield,
  Building2,
  Check,
  X,
  Lock,
  ExternalLink,
} from 'lucide-react';
import { formatMoney, shortRef } from '@/lib/format';
import type { CanonicalStage, StageEvidence } from '@/lib/workflow/stageEvidence';
import type {
  CommitmentEvidence,
  FulfillmentEvidence,
  IntentEvidence,
  NegotiationEvidence,
  PaymentEvidence,
  QuoteEvidence,
  ReconEvidence,
  SupplierEvidence,
  AllocationEvidence,
} from '@/lib/workflow/runEvidence';
import type { ResidentProfile } from '@/types';

interface StageCardProps {
  evidence: StageEvidence;
  index: number;
  runId?: string;
  intent?: IntentEvidence | null;
  suppliers?: SupplierEvidence | null;
  quotes?: QuoteEvidence | null;
  negotiation?: NegotiationEvidence | null;
  commitment?: CommitmentEvidence | null;
  payment?: PaymentEvidence | null;
  fulfillment?: FulfillmentEvidence | null;
  recon?: ReconEvidence | null;
  allocation?: AllocationEvidence | null;
  profile?: ResidentProfile | null;
  promptText?: string;
}

export function StageSpecificCard(props: StageCardProps) {
  const { evidence, index } = props;
  const stage = evidence.stage;

  switch (stage) {
    case 'UNDERSTAND':
      return <UnderstandStageCard {...props} />;
    case 'DISCOVER':
      return <DiscoverStageCard {...props} />;
    case 'QUALIFY':
      return <QualifyStageCard {...props} />;
    case 'QUOTE':
      return <QuoteStageCard {...props} />;
    case 'NEGOTIATE':
      return <NegotiateStageCard {...props} />;
    case 'SELECT':
      return <SelectStageCard {...props} />;
    case 'COMMIT':
      return <CommitStageCard {...props} />;
    case 'PAY':
      return <PayStageCard {...props} />;
    case 'FULFILL':
      return <FulfillStageCard {...props} />;
    case 'VERIFY':
      return <VerifyStageCard {...props} />;
    case 'ALLOCATE':
      return <AllocateStageCard {...props} />;
    case 'RECONCILE':
      return <ReconcileStageCard {...props} />;
    case 'COMPLETE':
      return <CompleteStageCard {...props} />;
    default:
      return <DefaultStageCard {...props} />;
  }
}

/** 01 UNDERSTAND */
function UnderstandStageCard({ intent }: StageCardProps) {
  // Backend evidence only: quantities/products are never parsed from prompt
  // text here. When the backend has not (yet) produced intent, say so.
  // Multi-item runs list each evidenced line; single-item keeps the legacy row.
  const items = intent?.items && intent.items.length > 0 ? intent.items : null;
  const hasIntent = items !== null || intent?.productName != null || intent?.quantity != null;
  // Backend-declared identity provenance: any open-world line switches the
  // caption off the catalog wording. Absent source keeps legacy caption.
  const hasOpenWorld = items?.some((line) => line.identitySource === 'open-world') ?? false;
  return (
    <div className="space-y-3">
      {/* AI Explanation banner */}
      <div className="rounded-2xl bg-relay-navy-50/80 border border-relay-navy-100 p-3 text-xs text-relay-ink-700 leading-relaxed flex items-start gap-2">
        <BrainCircuit className="h-4 w-4 text-relay-primary-600 shrink-0 mt-0.5" aria-hidden />
        <div>
          <strong className="text-relay-ink-900">Intent Recognized:</strong> Relay mapped your natural-language request into structured procurement requirements.
        </div>
      </div>

      {/* Identified Products */}
      <div className="rounded-2xl border border-relay-surface-border bg-[#12161D] p-3.5 space-y-2">
        <p className="text-[11px] font-bold uppercase tracking-wider text-relay-ink-500">
          Identified Procurement Products & Units
        </p>

        <div className="rounded-2xl border border-relay-surface-border bg-relay-surface-bg p-2.5">
          {items && items.length > 1 ? (
            <>
              <ul className="divide-y divide-relay-surface-border">
                {items.map((line, idx) => (
                  <li key={`${line.productName}-${idx}`} className="py-1.5 first:pt-0 last:pb-0 flex items-baseline justify-between gap-3">
                    <span className="text-sm font-bold text-relay-ink-900">
                      {line.productName}
                    </span>
                    <span className="text-sm font-mono text-relay-ink-700 tnum whitespace-nowrap">
                      {line.quantity ?? '—'} {line.unit ?? ''}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-relay-ink-500 mt-1.5">
                {hasOpenWorld
                  ? `Product understood · Open-world procurement item${items.length > 1 ? 's' : ''} · ${items.length} items`
                  : `Direct Resident Catalog Mapping · ${items.length} items`}
              </p>
            </>
          ) : hasIntent ? (
            <>
              <p className="text-sm font-bold text-relay-ink-900">
                {items?.[0]?.quantity ?? intent?.quantity ?? '—'} {items?.[0]?.unit ?? intent?.unit ?? ''} × {items?.[0]?.productName ?? intent?.productName ?? '—'}
              </p>
              <p className="text-[11px] text-relay-ink-500 mt-0.5">
                {hasOpenWorld ? 'Product understood · Open-world procurement item' : 'Direct Resident Catalog Mapping'}
              </p>
            </>
          ) : (
            <p className="text-xs text-relay-ink-500">No product mapping in this run yet.</p>
          )}
        </div>

        {hasOpenWorld && (
          <p className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-relay-navy-900 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-white">
              Open-World Item
            </span>
            <span className="text-[11px] text-relay-ink-500">
              Understood outside the predefined catalog — no catalog ID was invented.
            </span>
          </p>
        )}

        {/* Operational Constraints */}
        <div className="pt-2 border-t border-relay-surface-border flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-relay-ink-600">
          <span className="inline-flex items-center gap-1 font-medium">
            <Clock className="h-3.5 w-3.5 text-relay-primary-600" aria-hidden />
            {intent?.operationalSlaHours
              ? `${intent.operationalSlaHours}-Hour Operational SLA Guarantee`
              : '12-Hour Operational SLA Constraint'}
          </span>
          <span className="inline-flex items-center gap-1 font-medium">
            <Shield className="h-3.5 w-3.5 text-relay-primary-600" aria-hidden />
            Community Mandate Pre-authorized
          </span>
        </div>
        {intent?.requestedDeadlineHours !== null &&
          intent?.requestedDeadlineHours !== undefined && (
            <p className="text-[11px] text-relay-ink-500 leading-relaxed">
              Requested: within {intent.requestedDeadlineHours}h · Relay operational guarantee:{' '}
              {intent.operationalSlaHours ?? 12}h.
              {(intent.operationalSlaHours ?? 12) > intent.requestedDeadlineHours &&
                ' The tighter request is noted, not guaranteed — fulfillment is promised under the Relay guarantee.'}
            </p>
          )}
      </div>
    </div>
  );
}

/** 02 DISCOVER */
function DiscoverStageCard({ suppliers }: StageCardProps) {
  const count = suppliers?.eligibleCount ?? suppliers?.suppliers?.length ?? null;
  const qualified = suppliers?.qualifiedCount ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-relay-ink-600">
          Commercial Discovery Radius: <strong className="text-relay-ink-900 font-semibold">Configured Service Area</strong>
        </span>
        <span className="font-mono text-relay-primary-700 font-bold bg-relay-primary-50 px-2 py-0.5 rounded">
          {count ?? '—'} Commercial Candidates Discovered
        </span>
      </div>

      {suppliers?.suppliers && suppliers.suppliers.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
          {suppliers.suppliers.slice(0, 3).map((sup, idx) => (
            <div
              key={sup.supplierId || idx}
              className="rounded-2xl border border-relay-surface-border bg-[#12161D] p-2.5 space-y-1 shadow-sm"
            >
              <div className="flex items-center justify-between gap-1">
                <p className="text-xs font-bold text-relay-ink-900 truncate">{sup.supplierName}</p>
                <span className="text-[10px] font-mono text-relay-ink-500 shrink-0">
                  {sup.distanceKm ? `${sup.distanceKm}km` : 'Nearby'}
                </span>
              </div>
              <p className="text-[11px] text-relay-ink-500">
                Radius {sup.serviceRadiusKm ?? '—'}km
                {sup.deliverySlaHours !== null && sup.deliverySlaHours !== undefined
                  ? ` · SLA ${sup.deliverySlaHours}h`
                  : ''}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-relay-ink-600 italic">Discovered eligible commercial candidates in configured area.</p>
      )}
    </div>
  );
}

/** 03 QUALIFY */
function QualifyStageCard({ suppliers }: StageCardProps) {
  const total = suppliers?.eligibleCount ?? suppliers?.suppliers?.length ?? null;
  const qualified = suppliers?.qualifiedCount ?? null;
  const anyPassed = qualified !== null && qualified > 0;

  // Backend-verified gate vocabulary (DeterministicQualificationService):
  // business info, radius, category, contactability, 12h SLA feasibility.
  const gates = [
    'Valid Business Info',
    'Distance Within Radius',
    'Category Match',
    'Contact Available',
    'Hard SLA Window (≤12 Hours)',
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-relay-ink-600">
          Deterministic Qualification Gate: <strong className="text-relay-ink-900 font-semibold">{qualified ?? '—'} of {total ?? '—'} candidates passed</strong>
        </span>
        {anyPassed ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-relay-success-700 bg-relay-success-50 border border-relay-success-100 px-2 py-0.5 rounded-full">
            <Check className="h-3 w-3" /> Gates Passed
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-relay-ink-500 bg-relay-surface-sunken border border-relay-surface-border px-2 py-0.5 rounded-full">
            No candidates passed
          </span>
        )}
      </div>

      {anyPassed ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1 text-xs">
          {gates.map((label) => (
            <div key={label} className="rounded-2xl border border-relay-surface-border bg-[#12161D] p-2 flex items-center gap-2">
              <CheckCircle className="h-3.5 w-3.5 text-relay-success-600 shrink-0" aria-hidden />
              <span className="text-[11px] font-medium text-relay-ink-800 leading-tight">{label}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-relay-ink-500">
          No candidates satisfied the deterministic qualification gates for this run.
        </p>
      )}
    </div>
  );
}

/** 04 QUOTE */
function QuoteStageCard({ quotes }: StageCardProps) {
  const offers = quotes?.offers ?? [];
  // Displayed offers are received (pre-negotiation) terms whenever the run
  // also produced a negotiated winner; the winning terms live in Selection.
  const initialOnly = quotes?.hasNegotiatedWinner === true;

  return (
    <div className="space-y-3">
      <p className="text-xs text-relay-ink-600">
        {initialOnly
          ? 'Initial Supplier Quotes — received terms, normalized on unit price, fulfillment SLA, and reliability'
          : 'Wholesale Quotes Normalized on Unit Price, Fulfillment SLA, and Reliability'}
      </p>

      {quotes?.commercialBasisSimulated === true && (
        <p className="rounded-2xl border border-relay-surface-border bg-relay-surface-sunken px-3 py-2 text-[11px] leading-relaxed text-relay-ink-600">
          <strong className="font-semibold text-relay-ink-800">Commercial quote simulated.</strong>{' '}
          Supplier identity and discovery are real; commercial response is simulated.
        </p>
      )}

      {offers.length > 0 ? (
        <div className="overflow-x-auto rounded-2xl border border-relay-surface-border bg-[#12161D]">
          <table className="w-full text-left text-xs">
            <thead className="bg-relay-surface-sunken text-relay-ink-500 font-semibold border-b border-relay-surface-border">
              <tr>
                <th className="px-3 py-2">Supplier</th>
                <th className="px-3 py-2 text-right">Normalized Total</th>
                <th className="px-3 py-2 text-center">SLA</th>
                <th className="px-3 py-2 text-center">Reliability</th>
                <th className="px-3 py-2 text-right">Eligibility</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-relay-surface-border font-medium">
              {offers.map((offer) => (
                <tr key={offer.supplierId ?? offer.supplierName} className={offer.selected ? 'bg-relay-primary-50/50' : ''}>
                  <td className="px-3 py-2.5 font-semibold text-relay-ink-900">
                    {offer.supplierName}
                    {offer.selected && (
                      <span className="ml-2 inline-flex items-center text-[10px] bg-relay-primary-600 text-white px-1.5 py-0.2 rounded font-mono">
                        BEST
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-relay-ink-900 tnum">
                    {offer.totalPrice ? formatMoney(offer.totalPrice) : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-center font-mono tnum">
                    {offer.deliveryHours ? `${offer.deliveryHours}h` : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-center font-mono tnum text-relay-success-700">
                    {offer.reliabilityScore ? `${(offer.reliabilityScore * 100).toFixed(0)}%` : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {offer.eligible === true ? (
                      <span className="inline-flex items-center text-[11px] font-semibold text-relay-success-700 bg-relay-success-50 px-2 py-0.5 rounded">
                        Eligible
                      </span>
                    ) : offer.eligible === false ? (
                      <span className="inline-flex items-center text-[11px] font-semibold text-relay-danger-700 bg-relay-danger-50 px-2 py-0.5 rounded">
                        Ineligible
                      </span>
                    ) : (
                      <span className="inline-flex items-center text-[11px] font-semibold text-relay-ink-500 bg-relay-surface-sunken px-2 py-0.5 rounded">
                        —
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-2xl border border-relay-surface-border bg-[#12161D] p-3 text-xs text-relay-ink-600">
          Ranked normalized wholesale offers with price and operational metrics.
        </div>
      )}

      {quotes?.lineItems && quotes.lineItems.length > 0 && (
        <div className="space-y-2 pt-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-wide uppercase text-relay-ink-500">
              Itemized Live Price Discovery & Unit Normalization
            </span>
            <span className="text-[10px] text-relay-ink-400 font-mono">
              Meta Muse Spark 1.3 Grounded Search
            </span>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-relay-surface-border bg-[#12161D]">
            <table className="w-full text-left text-xs">
              <thead className="bg-relay-surface-sunken text-relay-ink-500 font-semibold border-b border-relay-surface-border">
                <tr>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2 text-center">Requested Qty</th>
                  <th className="px-3 py-2 text-right">Discovered Rate</th>
                  <th className="px-3 py-2 text-right">Line Subtotal</th>
                  <th className="px-3 py-2 text-center">Source & Provenance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-relay-surface-border font-medium">
                {quotes.lineItems.map((li, idx) => (
                  <tr key={`${li.productName}-${idx}`}>
                    <td className="px-3 py-2 text-relay-ink-900 font-medium capitalize">
                      {li.productName}
                      {li.packageSizeNote && (
                        <span className="block text-[10px] text-relay-ink-500 font-normal">
                          {li.packageSizeNote}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center font-mono tnum text-relay-ink-700">
                      {li.quantity} {li.unit}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tnum text-relay-ink-900">
                      {li.unitPrice ? `₹${li.unitPrice.toFixed(2)}/${li.pricingUnit || 'kg'}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tnum font-semibold text-relay-ink-900">
                      {li.lineSubtotal ? formatMoney(li.lineSubtotal) : '—'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <div className="flex items-center justify-center gap-1.5 flex-wrap">
                        {li.sourceUrl ? (
                          <a
                            href={li.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-relay-primary-400 hover:text-relay-primary-300 underline"
                          >
                            <span>{li.merchant || 'Live Listing'}</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : (
                          <span className="text-[11px] text-relay-ink-600">
                            {li.merchant || 'Market Estimate'}
                          </span>
                        )}
                        <span
                          className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-semibold uppercase ${
                            li.provenanceStatus === 'VERIFIED_LIVE_LISTING'
                              ? 'bg-relay-success-500/10 text-relay-success-400 border border-relay-success-500/20'
                              : 'bg-relay-primary-500/10 text-relay-primary-400 border border-relay-primary-500/20'
                          }`}
                        >
                          {li.provenanceStatus === 'VERIFIED_LIVE_LISTING' ? 'LIVE' : 'ESTIMATE'}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-relay-ink-500 italic px-1 pt-1">
            * Commercial quotes include estimated delivery and GST. Note: Under Indian GST laws, basic unbranded staples (fresh produce, loose grains, milk) attract 0% GST, while packaged grocery goods attract 5%–12%.
          </p>
        </div>
      )}
    </div>
  );
}

/** 05 NEGOTIATE */
function NegotiateStageCard({ negotiation }: StageCardProps) {
  const hasRounds = negotiation && negotiation.rounds.length > 0;

  return (
    <div className="space-y-3">
      {hasRounds ? (
        <div className="rounded-2xl border border-relay-success-200 bg-relay-success-50/50 p-4 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-relay-success-800 uppercase tracking-wider">
              Collective Demand Leverage
            </span>
            <span className="font-mono text-relay-success-700 font-bold bg-[#12161D] px-2 py-0.5 rounded border border-relay-success-200">
              Volume Terms Verified
            </span>
          </div>
          {/* Agent action sequence: backend rounds arrive as
              initial → proposal → counter → final per negotiated quote. */}
          <ol className="space-y-0">
            {negotiation.rounds.map((round, idx) => {
              const stepLabels = ['Initial Offer', 'Relay Proposal', 'Supplier Counter', 'Final Terms'];
              const stepLabel = stepLabels[idx % 4];
              return (
                <li key={idx} className="relative flex gap-3 pb-4 last:pb-0">
                  {idx < negotiation.rounds.length - 1 && (
                    <span aria-hidden className="absolute left-[13px] top-7 bottom-0 w-px bg-relay-success-600/30" />
                  )}
                  <span className="relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#12161D] border border-relay-success-600/40 font-mono text-[10px] font-bold text-relay-success-700">
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0 pt-0.5">
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-relay-success-700">
                      {stepLabel}
                    </p>
                    <p className="font-mono text-xs text-relay-success-900 mt-0.5 leading-relaxed">{round.summary}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <div className="rounded-2xl border border-relay-surface-border bg-[#12161D] p-4 text-xs text-relay-ink-600 space-y-1">
          <p className="font-semibold text-relay-ink-800">
            No negotiation round in this run — selection proceeded on quoted terms.
          </p>
          <p className="text-[11px] text-relay-ink-500">
            The backend recorded no negotiation rounds for this run.
          </p>
        </div>
      )}
    </div>
  );
}

/** 06 SELECT */
function SelectStageCard({ quotes }: StageCardProps) {
  // Backend-selected winner ONLY. Never fall back to the first offer by
  // position: an unmarked list means "no selection evidence", not "the
  // first quote won".
  const selected = quotes?.offers.find((o) => o.selected) ?? null;
  const winnerName = quotes?.selectedSupplierName || selected?.supplierName || null;
  // Authoritative winning terms come from the commitment (negotiated), not
  // from the received-terms offer row. Shown only when backend evidence
  // confirms a negotiated winner; never invented.
  const showNegotiatedWin =
    quotes?.hasNegotiatedWinner === true && quotes?.winningTotal != null;
  const winningTotal = showNegotiatedWin ? quotes!.winningTotal : selected?.totalPrice ?? null;

  if (!winnerName && !selected) {
    return (
      <div className="rounded-2xl border border-relay-surface-border bg-[#12161D] p-4 text-xs text-relay-ink-600">
        No backend-selected winner in this run — selection evidence was not recorded.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Hallmark: Muse recommends. Relay verifies. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[11px] text-relay-ink-500">
          Muse recommends. Relay verifies.
        </p>
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-relay-success-700">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          Validated by Relay Selection Rules
        </span>
      </div>

      <div className="rounded-2xl border border-relay-surface-border bg-[#12161D] p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs text-relay-ink-500">
            Selected Winning Supplier
          </p>
          <h4 className="text-lg sm:text-xl font-semibold tracking-tight text-relay-ink-900 mt-1">
            {winnerName ?? '—'}
          </h4>
          <p className="text-xs text-relay-ink-600 mt-1">
            Tradeoff: {selected?.deliveryHours ? `${selected.deliveryHours}h SLA` : 'SLA per commitment'} · {selected?.reliabilityScore ? `${(selected.reliabilityScore * 100).toFixed(0)}% Reliability` : 'Backend eligibility checks passed'}
          </p>
          {quotes?.selectionReason && (
            <p className="text-xs text-relay-ink-700 mt-2 leading-relaxed">
              <span className="font-bold text-relay-ink-900">Why Relay chose this: </span>
              {quotes.selectionReason}
            </p>
          )}
        </div>

        <div className="text-right font-mono">
          <p className="text-xs text-relay-ink-500">
            {showNegotiatedWin ? 'Winning Negotiated Quote' : 'Validated Price'}
          </p>
          <p className="text-lg font-bold text-relay-ink-900 tnum">
            {winningTotal ? formatMoney(winningTotal) : '—'}
          </p>
          {showNegotiatedWin && (
            <p className="text-[10px] text-relay-ink-500 mt-0.5">
              Negotiated in Stage 05 · locked in Commitment
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** 07 COMMIT */
function CommitStageCard({ commitment }: StageCardProps) {
  const ref = commitment?.id
    ? (/^(commit|comm)_/i.test(commitment.id) ? shortRef(commitment.id) : shortRef(commitment.id, 'COMM-'))
    : '—';
  const total = commitment?.totalAmount ? formatMoney(commitment.totalAmount) : '—';

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-relay-surface-border bg-[#12161D] p-4 space-y-3">
        <div className="flex items-center justify-between text-xs border-b border-relay-surface-border pb-2.5">
          <span className="text-relay-ink-600 font-medium">Community Purchase Commitment</span>
          <span className="font-mono font-bold text-relay-ink-900 bg-relay-surface-sunken px-2 py-0.5 rounded">
            {ref}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
          <div>
            <p className="text-relay-ink-500">Committed Amount</p>
            <p className="text-sm font-bold font-mono text-relay-ink-900 mt-0.5 tnum">{total}</p>
          </div>
          <div>
            <p className="text-relay-ink-500">Status</p>
            <p className="text-sm font-bold text-relay-success-700 mt-0.5">{commitment?.status ?? '—'}</p>
          </div>
          <div>
            <p className="text-relay-ink-500">Quantity Conservation</p>
            <p className="text-sm font-bold text-relay-ink-900 mt-0.5">Sum(Demand) = PO Vol</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 08 PAY */
function PayStageCard({ payment, profile }: StageCardProps) {
  const ref = payment?.providerReference || '—';
  const amount = payment?.amount ? formatMoney(payment.amount, payment.currency) : '—';

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-relay-surface-border bg-[#12161D] p-4 space-y-3 shadow-sm">
        <div className="flex items-center justify-between text-xs border-b border-relay-surface-border pb-2">
          <div className="flex items-center gap-1.5">
            <CreditCard className="h-4 w-4 text-relay-primary-600" />
            <span className="font-bold uppercase tracking-wider text-relay-ink-800">
              Payment Authorization & Settlement
            </span>
          </div>
          <span className="inline-flex items-center gap-1 rounded bg-relay-success-50 text-relay-success-700 border border-relay-success-200 px-2 py-0.5 font-bold font-mono text-[11px]">
            <CheckCircle className="h-3 w-3" /> {payment?.status ?? '—'}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div>
            <p className="text-relay-ink-500">Authorized Debit</p>
            <p className="text-sm font-bold font-mono text-relay-ink-900 mt-0.5 tnum">{amount}</p>
          </div>
          <div>
            <p className="text-relay-ink-500">Pre-authorized Cap</p>
            <p className="text-sm font-bold font-mono text-relay-ink-900 mt-0.5 tnum">
              {profile?.activeMandate?.maximumAmount
                ? formatMoney(profile.activeMandate.maximumAmount, profile.activeMandate.currency)
                : '—'}
            </p>
          </div>
          <div>
            <p className="text-relay-ink-500">Provider Ref</p>
            <p className="text-xs font-mono font-bold text-relay-ink-700 mt-1 truncate">{ref}</p>
          </div>
          <div>
            <p className="text-relay-ink-500">Idempotency</p>
            <p className="text-xs font-bold text-relay-success-700 mt-1">
              {payment?.isDuplicate === false ? 'Key Verified' : payment?.isDuplicate === true ? 'Duplicate Blocked' : '—'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 09 FULFILL */
function FulfillStageCard({ fulfillment, quotes }: StageCardProps) {
  const tracking = fulfillment?.trackingCode || '—';
  const status = fulfillment?.status || '—';
  const committedSla = quotes?.offers?.find((o) => o.selected)?.deliveryHours
    ? `${quotes.offers.find((o) => o.selected)?.deliveryHours} Hours`
    : fulfillment?.confirmedDeliveryEta
      ? fulfillment.confirmedDeliveryEta
      : '—';
  const delivered = fulfillment?.status === 'DELIVERED' || fulfillment?.status === 'VERIFIED';

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-relay-surface-border bg-[#12161D] p-4 space-y-3">
        <div className="flex items-center justify-between text-xs border-b border-relay-surface-border pb-2">
          <div className="flex items-center gap-1.5">
            <Truck className="h-4 w-4 text-relay-primary-600" />
            <span className="font-bold uppercase tracking-wider text-relay-ink-800">
              Operational Fulfillment
            </span>
          </div>
          <span className="font-mono text-xs font-bold text-relay-primary-700 bg-relay-primary-50 px-2 py-0.5 rounded">
            {status}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
          <div>
            <p className="text-relay-ink-500">Tracking Reference</p>
            <p className="text-xs font-mono font-bold text-relay-ink-900 mt-0.5">{tracking}</p>
          </div>
          <div>
            <p className="text-relay-ink-500">Committed SLA</p>
            <p className="text-xs font-bold text-relay-ink-900 mt-0.5">{committedSla}</p>
          </div>
          <div>
            <p className="text-relay-ink-500">Society Gate Delivery</p>
            <p className={`text-xs font-bold mt-0.5 ${delivered ? 'text-relay-success-700' : 'text-relay-ink-500'}`}>
              {delivered ? 'Cleared for Entry' : fulfillment?.status ? 'In Progress' : '—'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 10 VERIFY */
function VerifyStageCard({ fulfillment }: StageCardProps) {
  const method = fulfillment?.verificationEvidenceType
    ? fulfillment.verificationEvidenceType.replace(/_/g, ' ').toLowerCase()
    : null;
  const verifier = fulfillment?.verifiedBy ?? null;
  return (
    <div className="space-y-2">
      <div className="rounded-2xl border border-relay-success-200 bg-relay-success-50/40 p-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-relay-success-600" />
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-relay-success-800">
              Delivery Verified at Society Gate
            </p>
            <p className="text-xs text-relay-ink-700 mt-0.5">
              {method
                ? `Backend verification: ${method}${verifier ? ` · confirmed by ${verifier}` : ''}.`
                : 'Backend delivery record confirmed before resident ledger release.'}
              {fulfillment?.verificationSimulated === true && ' Verification evidence is simulated.'}
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 font-mono text-xs font-bold text-relay-success-700 bg-[#12161D] border border-relay-success-200 px-2.5 py-1 rounded-full">
          VERIFIED
        </span>
      </div>
    </div>
  );
}

/** 11 ALLOCATE */
function AllocateStageCard({ profile, allocation }: StageCardProps) {
  const flat = profile?.flatNumber || '—';
  const society = profile?.societyName || '—';

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-relay-surface-border bg-[#12161D] p-4 space-y-2.5">
        <div className="flex items-center justify-between text-xs border-b border-relay-surface-border pb-2">
          <div className="flex items-center gap-1.5 text-relay-ink-700 font-semibold">
            <Building2 className="h-4 w-4 text-relay-primary-600" />
            <span>Unit-Level Distribution · {society}</span>
          </div>
          <span className="font-mono text-xs font-bold text-relay-primary-700 bg-relay-primary-50 px-2 py-0.5 rounded">
            Flat {flat}
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-relay-ink-600">
          <p>
            Procured batch apportioned to resident order. Private resident orders remain strictly partitioned.
          </p>
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-relay-ink-500">
            <Lock className="h-3 w-3" /> Privacy Preserved
          </span>
        </div>
      </div>
    </div>
  );
}

/** 12 RECONCILE */
function ReconcileStageCard({ recon }: StageCardProps) {
  const diff = recon?.financial?.difference ?? null;
  const confirmedZero = diff === '0' || diff === '0.00';

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-relay-success-300 bg-relay-success-50/50 p-4 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5">
            <Scale className="h-4 w-4 text-relay-success-700" />
            <span className="font-bold uppercase tracking-wider text-relay-success-900">
              Four-Pillar Mathematical Balancing
            </span>
          </div>
          <span className="font-mono text-xs font-bold text-relay-success-700 bg-[#12161D] border border-relay-success-200 px-2 py-0.5 rounded">
            Δ = {diff === null ? '—' : `₹${diff}`}
          </span>
        </div>
        <p className="text-xs text-relay-success-900 leading-relaxed">
          Community Demand = Supplier PO = Provider Debit = Resident Allocation.{' '}
          {confirmedZero
            ? 'Zero financial discrepancy confirmed.'
            : 'Discrepancy not confirmed — see reconciliation evidence.'}
        </p>
      </div>
    </div>
  );
}

/** 13 COMPLETE */
function CompleteStageCard(_props: StageCardProps) {
  return (
    <div className="rounded-2xl border border-relay-success-100 bg-relay-success-50 p-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#12161D] border border-relay-success-100 text-relay-success-600">
          <CheckCircle className="h-4 w-4" aria-hidden />
        </span>
        <div>
          <p className="text-xs font-semibold text-relay-success-700">
            Procurement Lifecycle Concluded
          </p>
          <p className="text-xs text-relay-ink-600 mt-0.5">
            Completion checkpoint recorded in the audit trail.
          </p>
        </div>
      </div>
      <span className="text-xs font-mono font-semibold text-relay-success-700">
        CLOSED
      </span>
    </div>
  );
}

/** Fallback */
function DefaultStageCard({ evidence }: StageCardProps) {
  return (
    <div className="rounded-2xl border border-relay-surface-border bg-[#12161D] p-3 text-xs text-relay-ink-700">
      {evidence.summary}
    </div>
  );
}
