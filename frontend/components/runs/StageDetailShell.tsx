'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import { Container } from '@/components/ui';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { EmptyState, LoadingState } from '@/components/feedback/Feedback';
import { useRunStore } from '@/lib/workflow/runStore';
import { mapRunToStages, type CanonicalStage } from '@/lib/workflow/stageEvidence';
import { getStageIntelligence } from '@/lib/workflow/intelligence';
import { shortRef } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ProcurementRun } from '@/lib/workflow/types';
import { ApiClientError } from '@/lib/api/client';

export const STAGE_ROUTE_ORDER: { slug: string; stage: CanonicalStage; label: string }[] = [
  { slug: 'understand', stage: 'UNDERSTAND', label: 'Understand' },
  { slug: 'discover', stage: 'DISCOVER', label: 'Discover' },
  { slug: 'qualify', stage: 'QUALIFY', label: 'Qualify' },
  { slug: 'quotes', stage: 'QUOTE', label: 'Quotes' },
  { slug: 'negotiation', stage: 'NEGOTIATE', label: 'Negotiation' },
  { slug: 'selection', stage: 'SELECT', label: 'Selection' },
  { slug: 'commitment', stage: 'COMMIT', label: 'Commitment' },
  { slug: 'payment', stage: 'PAY', label: 'Payment' },
  { slug: 'fulfillment', stage: 'FULFILL', label: 'Fulfillment' },
  { slug: 'verification', stage: 'VERIFY', label: 'Verification' },
  { slug: 'allocation', stage: 'ALLOCATE', label: 'Allocation' },
  { slug: 'reconciliation', stage: 'RECONCILE', label: 'Reconciliation' },
];

export function StageDetailShell({
  runId,
  slug,
  eyebrow,
  description,
  children,
}: {
  runId: string;
  slug: string;
  eyebrow: string;
  description: string;
  children: (run: NonNullable<ReturnType<ReturnType<typeof useRunStore>['getRun']>>) => React.ReactNode;
}) {
  const { getRun, fetchRun, ready } = useRunStore();
  const localRun = ready ? getRun(runId) : null;
  const [remoteRun, setRemoteRun] = useState<ProcurementRun | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<{ code: string; message: string } | null>(null);

  useEffect(() => {
    if (ready && !localRun && !remoteRun && !fetching && !fetchError && runId) {
      setFetching(true);
      fetchRun(runId)
        .then((fetched) => {
          setRemoteRun(fetched);
          setFetching(false);
        })
        .catch((err) => {
          setFetching(false);
          if (err instanceof ApiClientError && err.status === 403) {
            setFetchError({
              code: 'FORBIDDEN',
              message: 'You are not authorized to view this mission record.',
            });
          } else if (err instanceof ApiClientError && err.status === 404) {
            setFetchError({
              code: 'NOT_FOUND',
              message: `Procurement mission '${runId}' could not be found.`,
            });
          } else {
            setFetchError({
              code: 'ERROR',
              message: err instanceof Error ? err.message : 'Failed to retrieve mission record.',
            });
          }
        });
    }
  }, [ready, localRun, remoteRun, fetching, fetchError, fetchRun, runId]);

  const run = localRun || remoteRun;
  const isLoading = !ready || (fetching && !run);
  const entry = STAGE_ROUTE_ORDER.find((s) => s.slug === slug)!;
  const index = STAGE_ROUTE_ORDER.indexOf(entry);
  const prev = index > 0 ? STAGE_ROUTE_ORDER[index - 1] : null;
  const next = index < STAGE_ROUTE_ORDER.length - 1 ? STAGE_ROUTE_ORDER[index + 1] : null;

  const stages = run ? mapRunToStages(run) : [];
  const evidence = stages.find((s) => s.stage === entry.stage);
  const intel = run ? getStageIntelligence(entry.stage, run) : [];

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-5xl mx-auto">
          <nav className="flex items-center gap-1.5 text-[13px] text-relay-ink-600" aria-label="Breadcrumb">
            <Link href={`/runs/${runId}`} className="inline-flex items-center gap-1 font-medium hover:text-relay-ink-900 min-h-[32px]">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              {shortRef(runId, 'RUN-')}
            </Link>
            <span aria-hidden>/</span>
            <span className="font-semibold text-relay-ink-900">{entry.label}</span>
          </nav>

          {isLoading && <LoadingState title={`Loading ${entry.label.toLowerCase()}`} />}

          {!isLoading && fetchError && (
            <EmptyState
              title={fetchError.code === 'FORBIDDEN' ? 'Access Denied' : 'Run not found'}
              description={fetchError.message}
              actionLabel="All runs"
              onAction={() => (window.location.href = '/runs')}
            />
          )}

          {!isLoading && !fetchError && !run && (
            <EmptyState
              title="Run not found"
              description="This run is not in the active session or backend archive."
              actionLabel="All runs"
              onAction={() => (window.location.href = '/runs')}
            />
          )}

          {!isLoading && run && evidence && (
            <>
              <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
                <div>
                  <p className="font-mono text-[11px] text-relay-ink-500">
                    {eyebrow}
                  </p>
                  <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-relay-ink-900 mt-1">
                    {entry.label}
                  </h1>
                  <p className="text-sm text-relay-ink-600 mt-1.5 leading-relaxed max-w-2xl">
                    {description}
                  </p>
                </div>
                {evidence.state === 'verified' && <Badge variant="success">Verified</Badge>}
                {evidence.state === 'absent' && <Badge variant="neutral">No evidence</Badge>}
                {evidence.state === 'failed' && <Badge variant="error">Failed</Badge>}
              </div>

              <div className={`rounded-2xl border px-5 py-4 ${evidence.state === 'failed' ? 'border-relay-danger-100 bg-relay-danger-50' : 'border-relay-surface-border bg-relay-surface-sunken/60'}`}>
                <div className="flex items-start gap-3">
                  {evidence.state === 'verified' && <CheckCircle2 className="h-5 w-5 text-relay-success-600 shrink-0 mt-0.5" aria-hidden />}
                  {evidence.state === 'absent' && <CircleDashed className="h-5 w-5 text-relay-ink-400 shrink-0 mt-0.5" aria-hidden />}
                  {evidence.state === 'failed' && <XCircle className="h-5 w-5 text-relay-danger-600 shrink-0 mt-0.5" aria-hidden />}
                  <div>
                    <p className="text-[15px] font-medium leading-relaxed text-relay-ink-900">{evidence.summary}</p>
                    {evidence.source && (
                      <p className="text-xs font-mono text-relay-ink-500 mt-1.5">
                        source: {evidence.source}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {intel.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Relay Intelligence · {entry.label}</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <ul className="space-y-1.5">
                      {intel.map((line, i) => (
                        <li key={i} className="text-sm text-relay-ink-900 leading-relaxed flex gap-2.5">
                          <span className="mt-[7px] h-1.5 w-1.5 rounded-full bg-relay-primary-500 shrink-0" aria-hidden />
                          {line}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}

              {children(run)}

              {/* Prev / next */}
              <div className="flex items-center justify-between gap-3 pt-2">
                {prev ? (
                  <Link
                    href={`/runs/${runId}/${prev.slug}`}
                    className="inline-flex items-center gap-1.5 text-sm font-semibold text-relay-primary-600 hover:text-relay-primary-700 min-h-[44px]"
                  >
                    <ArrowLeft className="h-4 w-4" aria-hidden />
                    {prev.label}
                  </Link>
                ) : (
                  <span />
                )}
                <Link
                  href={`/runs/${runId}`}
                  className="text-xs font-medium text-relay-ink-500 hover:text-relay-ink-900 min-h-[44px] inline-flex items-center"
                >
                  Journey
                </Link>
                {next ? (
                  <Link
                    href={`/runs/${runId}/${next.slug}`}
                    className={cn('inline-flex items-center gap-1.5 text-sm font-semibold text-relay-primary-600 hover:text-relay-primary-700 min-h-[44px]')}
                  >
                    {next.label}
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </Link>
                ) : (
                  <span />
                )}
              </div>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}

export function EvidenceFacts({ facts }: { facts: { label: string; value: string }[] }) {
  if (facts.length === 0) return null;
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
      {facts.map((f) => (
        <div key={`${f.label}-${f.value}`} className="border-b border-relay-surface-border pb-2.5">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-relay-ink-500">
            {f.label}
          </dt>
          <dd className="text-sm text-relay-ink-900 font-medium mt-1 break-words tnum">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}
