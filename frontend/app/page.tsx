'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ArrowRight, Building2, Layers, Play } from 'lucide-react';
import { Container } from '@/components/ui';
import { CommandComposer } from '@/components/command/CommandComposer';
import { OperationsOverview } from '@/components/command/OperationsOverview';
import { Skeleton } from '@/components/feedback/Feedback';
import { useSession } from '@/lib/session/SessionContext';
import { useResidentContext } from '@/lib/session/useResidentContext';
import { useMissionSession } from '@/lib/workflow/MissionSessionContext';

/** Genuine session-resolution splash: shown only while auth state is unknown. */
function SessionSplash({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-4 py-24"
      role="status"
      aria-label="Loading Relay"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-md bg-relay-navy-900">
        <Layers className="h-5 w-5 text-white" aria-hidden />
      </span>
      <div className="text-center">
        <p className="font-semibold text-relay-ink-900 text-lg tracking-tight">Relay</p>
        <p className="text-sm text-relay-ink-500 mt-1">Checking your session…</p>
        {error && (
          <>
            <p className="text-sm text-relay-ink-700 mt-2 max-w-sm">{error}</p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-1 text-sm font-semibold text-relay-primary-600 hover:text-relay-primary-700 min-h-[36px] px-3"
              >
                Retry
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Preselected hackathon demo request: fully specified (every line carries an
 * explicit unit), verified to resolve with zero clarification on the real
 * model path. Mixes catalog staples with one open-world branded item.
 */
const DEMO_REQUEST = '2 kg rice, 1 kg sugar and 2 packs Maggi';

export default function CommandCenterPage() {
  const { status: sessionStatus, error: sessionError, refresh: refreshSession } = useSession();
  const resident = useResidentContext();
  const { run, start, setDemoMode } = useMissionSession();
  const router = useRouter();

  const [composerClearToken, setComposerClearToken] = useState(0);
  // Example-chip fill: remounts the composer with the chosen prompt prefilled.
  const [fillNonce, setFillNonce] = useState(0);
  // Edit-and-retry prefill (?prompt=... from a blocked run). Read once from
  // window.location (SSR-safe) instead of useSearchParams to avoid forcing a
  // Suspense boundary on the command center.
  const [retryPrompt, setRetryPrompt] = useState(() =>
    typeof window === 'undefined'
      ? ''
      : (new URLSearchParams(window.location.search).get('prompt') ?? ''),
  );

  const anonymous = sessionStatus === 'anonymous' || resident.unauthorized;
  const mandate = resident.mandate;
  const mandateMissing = !resident.loading && !anonymous && !mandate;
  const canProcure =
    !anonymous && !mandateMissing && !resident.loading && sessionStatus === 'authenticated';

  // Login-first: logged-out visitors go to the entry experience. Driven by
  // the verified session mechanism — never a hardcoded flag.
  useEffect(() => {
    if (anonymous && sessionStatus !== 'loading') {
      router.replace('/login');
    }
  }, [anonymous, sessionStatus, router]);

  const submitMission = (prompt: string, demo: boolean) => {
    setDemoMode(demo);
    setComposerClearToken((t) => t + 1);
    void start(prompt);
    router.push('/mission');
  };

  // Logged-out visitors never see the command center; the redirect above
  // sends them to /login. Genuine loading state only while resolving.
  if (sessionStatus === 'loading' || anonymous) {
    return (
      <SessionSplash
        error={sessionStatus === 'loading' ? sessionError : null}
        onRetry={() => void refreshSession()}
      />
    );
  }

  return (
    <div className="py-6 sm:py-10">
      <Container size="xl">
        <div className="space-y-8 max-w-6xl mx-auto">
          {/* A live mission belongs to /mission: link there instead of duplicating it. */}
          {run.status !== 'idle' && (
            <Link
              href="/mission"
              className="flex items-center justify-between gap-3 rounded-2xl border border-relay-surface-border bg-[#12161D] px-4 py-3 text-sm shadow-none hover:border-relay-navy-200 transition-colors"
            >
              <span className="font-semibold text-relay-ink-900">
                {run.status === 'processing' && 'Relay is executing your mission.'}
                {run.status === 'failed' && 'Your mission needs attention.'}
                {run.status === 'complete' && 'Your mission is complete.'}
              </span>
              <span className="inline-flex items-center gap-1 font-semibold text-relay-primary-700 shrink-0">
                View mission
                <ArrowRight className="h-4 w-4" aria-hidden />
              </span>
            </Link>
          )}
          <motion.div
            key="command-center-home"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="space-y-8"
          >
            {/* Identity line: quiet, secondary to the request itself */}
            <div className="space-y-5">
              {resident.loading ? (
                <div className="pt-1">
                  <Skeleton className="h-4 w-56" />
                </div>
              ) : resident.profile ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-relay-ink-600">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-relay-ink-900">
                    <Building2 className="h-4 w-4 text-relay-ink-400" aria-hidden />
                    {resident.profile.societyName}
                  </span>
                  {resident.profile.flatNumber && (
                    <>
                      <span className="text-relay-ink-400" aria-hidden>·</span>
                      <span className="font-mono">{resident.profile.flatNumber}</span>
                    </>
                  )}
                  <span className="text-relay-ink-400" aria-hidden>·</span>
                  {mandate ? (
                    <span
                      className={
                        mandate.status === 'ACTIVE'
                          ? 'inline-flex items-center gap-1.5 text-relay-success-700 text-[12px] font-medium'
                          : 'inline-flex items-center gap-1.5 text-relay-warn-700 text-[12px] font-medium'
                      }
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${mandate.status === 'ACTIVE' ? 'bg-relay-success-600' : 'bg-relay-warn-600'}`}
                        aria-hidden
                      />
                      Mandate {mandate.status === 'ACTIVE' ? 'active' : mandate.status.toLowerCase()}
                    </span>
                  ) : (
                    <Link
                      href="/onboarding"
                      className="inline-flex items-center gap-1.5 text-relay-warn-700 text-[12px] font-medium hover:underline"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-relay-warn-600" aria-hidden />
                      No mandate yet — set one up
                    </Link>
                  )}
                </div>
              ) : null}
            </div>

            {/* The request is the page. Everything else recedes. */}
            <div className="relative">
              <div
                aria-hidden
                className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 h-56 w-[560px] max-w-full rounded-full bg-[#0866FF]/10 blur-3xl"
              />
              <div className="relative">
                <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-[#5B9BFF]">Command</p>
                <h1 className="text-[32px] sm:text-[40px] leading-[40px] sm:leading-[48px] font-semibold tracking-tight text-[#E8EAED] mt-3">
                  What does your community need?
                </h1>
                <p className="text-base leading-[26px] text-[#9AA3B2] mt-3 max-w-2xl">
                  Describe a requirement in plain words. Relay discovers suppliers, compares quotes, coordinates execution and proves every rupee.
                </p>
              </div>

              <div className="mt-6">
                {/* Composer */}
                <CommandComposer
              key={fillNonce}
              disabled={resident.loading}
              isProcessing={run.status === 'processing'}
              canProcure={canProcure}
              mandateLimit={mandate?.maximumAmount ?? null}
              mandateCurrency={mandate?.currency ?? 'INR'}
              mandateMissing={mandateMissing}
              anonymous={anonymous}
              compact={false}
              clearToken={composerClearToken}
              initialValue={retryPrompt || undefined}
              onSubmit={(prompt) => submitMission(prompt, false)}
            />

                {/* One-click demo: preselected fully-specified request, secondary to the composer. */}
                <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <button
                    type="button"
                    disabled={!canProcure}
                    onClick={() => submitMission(DEMO_REQUEST, true)}
                    className="inline-flex items-center gap-2 rounded-md border border-relay-surface-border bg-[#12161D] hover:border-relay-navy-200 hover:bg-relay-navy-50 disabled:opacity-50 px-3.5 py-2 text-[13px] font-semibold text-relay-ink-900 transition-colors min-h-[38px]"
                  >
                    <Play className="h-3.5 w-3.5 text-relay-ink-500" aria-hidden />
                    Run demo mission
                  </button>
                  <span className="text-[12px] text-relay-ink-500 font-mono">
                    “{DEMO_REQUEST}”
                  </span>
                </div>

                {/* Example requests: real prompts, one click to try */}
                <div className="relative z-10 mt-5 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-relay-ink-500 mr-1 select-none">Try</span>
                  {[
                    'Find the best bulk deal for 100 kg of rice',
                    'Compare suppliers for monthly cleaning supplies',
                    'I need 2 kg rice and 1 kg sugar',
                    'मुझे 3 किलो दूध चाहिए',
                  ].map((example) => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => {
                        setRetryPrompt(example);
                        setFillNonce((n) => n + 1);
                      }}
                      className="cursor-pointer select-none active:scale-[0.98] rounded-md border border-relay-surface-border bg-[#12161D] hover:border-relay-navy-200 hover:bg-relay-navy-50 px-2.5 py-1.5 text-[12.5px] text-relay-ink-700 transition-colors min-h-[32px] inline-flex items-center"
                    >
                      {example}
                    </button>
                  ))}
                </div>

                <p className="mt-5 text-[12.5px] text-relay-ink-500">
                  Muse recommends. Relay verifies and executes.
                </p>
              </div>
            </div>

            {/* How Relay works: the procurement journey, end to end. */}
            <section aria-label="How Relay works" className="rounded-2xl border border-[#262C37] bg-[#12161D] px-5 sm:px-6 py-5">
              <p className="font-mono text-xs uppercase tracking-[0.14em] text-[#8A94A6]">How Relay works</p>
              <ol className="mt-4 grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
                {[
                  'Request',
                  'Understand',
                  'Discover',
                  'Quote',
                  'Select',
                  'Pay',
                  'Fulfil',
                  'Reconcile',
                ].map((step, i) => (
                  <li key={step} className="rounded-xl border border-[#1E242E] bg-[#0D1117] px-3 py-3">
                    <span className="font-mono text-xs text-[#5B9BFF]">{String(i + 1).padStart(2, '0')}</span>
                    <span className="block text-[15px] font-medium text-[#E8EAED] mt-1">{step}</span>
                  </li>
                ))}
              </ol>
              <p className="text-[15px] leading-[24px] text-[#9AA3B2] mt-4">
                The model recommends. Deterministic code verifies, authorizes and executes.
              </p>
            </section>

            <OperationsOverview
              mandate={mandate}
              paymentsRemaining={
                resident.paymentsTrusted ? (resident.payments?.mandate?.remainingLimit ?? null) : null
              }
            />
          </motion.div>
        </div>
      </Container>
    </div>
  );
}
