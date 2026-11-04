'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { Handshake, CircleDashed, ArrowDown, ShieldCheck } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/feedback/Feedback';
import { StageDetailShell } from '@/components/runs/StageDetailShell';
import { getNegotiationEvidence } from '@/lib/workflow/runEvidence';

export default function NegotiationStagePage() {
  const params = useParams();
  const runId = params?.runId as string;

  return (
    <StageDetailShell
      runId={runId}
      slug="negotiation"
      eyebrow="Stage 05 · Negotiate"
      description="Negotiation rounds as an evidence timeline — strategy from Meta reasoning, bounds from deterministic validation."
    >
      {(run) => {
        const evidence = getNegotiationEvidence(run);
        if (!evidence) {
          return (
            <div className="space-y-4">
              <Card>
                <CardContent className="pt-5">
                  <div className="flex items-start gap-3">
                    <CircleDashed className="h-5 w-5 text-relay-ink-400 shrink-0 mt-0.5" aria-hidden />
                    <div>
                      <p className="text-[15px] font-semibold text-relay-ink-900">
                        No negotiation round on this run
                      </p>
                      <p className="text-sm text-relay-ink-600 leading-relaxed mt-1">
                        Relay completed selection without negotiating — the backend
                        recorded no negotiation rounds for this run. When Relay does
                        negotiate, each round appears here as a timeline with its outcome.
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <EmptyState
                title="Timeline empty"
                description="Negotiation evidence arrives only when the backend runs negotiation rounds."
              />
            </div>
          );
        }
        return (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Negotiation timeline</CardTitle>
                <CardDescription>
                  {evidence.rounds.length} recorded steps · outcomes only, never internal deliberation.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <ol className="space-y-1">
                  {evidence.rounds.map((round, index) => (
                    <li key={`${round.tool}-${index}`}>
                      <div className="flex items-start gap-3 rounded-2xl border border-relay-surface-border bg-[#12161D] px-4 py-3.5">
                        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-relay-navy-900 text-white shrink-0">
                          <Handshake className="h-4 w-4" aria-hidden />
                        </span>
                        <div className="min-w-0">
                          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-relay-ink-500">
                            Round {index + 1}
                          </p>
                          <p className="text-sm text-relay-ink-900 leading-relaxed mt-0.5">
                            {round.summary}
                          </p>
                          <p className="text-[11px] font-mono text-relay-ink-500 mt-1">{round.tool}</p>
                        </div>
                      </div>
                      {index < evidence.rounds.length - 1 && (
                        <div className="flex justify-center py-1" aria-hidden>
                          <ArrowDown className="h-4 w-4 text-relay-primary-500" />
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-5">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="h-4 w-4 text-relay-primary-600 shrink-0 mt-0.5" aria-hidden />
                  <div className="text-xs text-relay-ink-600 leading-relaxed">
                    <p className="font-semibold text-relay-ink-900 mb-0.5">Supplier Quote Negotiation vs Final Selection</p>
                    Negotiation targets and reduces specific supplier quotes. Stage 06 (Selection) then evaluates all supplier quotes (both negotiated offers and lowest baseline bids) to deterministically select the lowest total procurement cost.
                  </div>
                </div>
              </CardContent>
            </Card>

            <p className="text-xs text-relay-ink-500 leading-relaxed">
              Negotiation is bounded by backend round limits and every improved term is
              re-validated financially before it can become a candidate.
            </p>
          </div>
        );
      }}
    </StageDetailShell>
  );
}
