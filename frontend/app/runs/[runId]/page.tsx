'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Container } from '@/components/ui';
import { EmptyState, LoadingState } from '@/components/feedback/Feedback';
import { AutonomousMissionControl } from '@/components/mission/AutonomousMissionControl';
import { useRunStore } from '@/lib/workflow/runStore';
import { useResidentContext } from '@/lib/session/useResidentContext';
import type { ProcurementRun } from '@/lib/workflow/types';
import { ApiClientError } from '@/lib/api/client';

export default function RunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const runId = params?.runId as string;
  const { getRun, fetchRun, ready } = useRunStore();
  const resident = useResidentContext();

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
  const mandate = resident.mandate;
  const isLoading = !ready || (fetching && !run);

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-6 max-w-5xl mx-auto">
          <Link
            href="/runs"
            className="inline-flex items-center gap-1.5 text-[13px] text-relay-ink-600 hover:text-relay-ink-900 font-medium min-h-[32px]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            All runs
          </Link>

          {isLoading && <LoadingState title="Loading mission record" />}

          {!isLoading && fetchError && (
            <EmptyState
              title={fetchError.code === 'FORBIDDEN' ? 'Access Denied' : 'Run not found'}
              description={fetchError.message}
              actionLabel="All runs"
              onAction={() => router.push('/runs')}
            />
          )}

          {!isLoading && !fetchError && !run && (
            <EmptyState
              title="Run not found"
              description="This run could not be found in active memory or the durable archive."
              actionLabel="Go to command center"
              onAction={() => router.push('/')}
            />
          )}

          {!isLoading && run && (
            <AutonomousMissionControl
              prompt={run.prompt}
              run={run}
              isProcessing={false}
              residentProfile={resident.profile}
              mandateLimit={mandate?.maximumAmount ?? null}
              mandateCurrency={mandate?.currency ?? 'INR'}
              onReturnToCommandCenter={() => router.push('/')}
              onRetry={(p) => router.push(`/?prompt=${encodeURIComponent(p)}`)}
              initialRevealedIndex={12}
            />
          )}
        </div>
      </Container>
    </div>
  );
}
