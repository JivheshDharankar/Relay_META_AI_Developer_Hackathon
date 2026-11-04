'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Clock, Lock, Users, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { formatMoneyCompact } from '@/lib/format';

interface CommandComposerProps {
  disabled: boolean;
  isProcessing: boolean;
  canProcure: boolean;
  mandateLimit: number | null;
  mandateCurrency: string;
  mandateMissing: boolean;
  anonymous: boolean;
  compact?: boolean;
  /** Increment to clear the box (e.g. after the command moves to its run page). */
  clearToken?: number;
  /** Prefill for edit-and-retry flows (e.g. from a blocked run's failure panel). */
  initialValue?: string;
  onSubmit: (prompt: string) => void;
}

export function CommandComposer({
  disabled,
  isProcessing,
  canProcure,
  mandateLimit,
  mandateCurrency,
  mandateMissing,
  anonymous,
  compact = false,
  clearToken = 0,
  initialValue,
  onSubmit,
}: CommandComposerProps) {
  const [value, setValue] = useState(initialValue ?? '');

  useEffect(() => {
    if (initialValue !== undefined) {
      setValue(initialValue);
    }
  }, [initialValue]);

  useEffect(() => {
    if (clearToken > 0) {
      setValue('');
    }
  }, [clearToken]);

  const submit = () => {
    const prompt = value.trim();
    if (!prompt || disabled || isProcessing || !canProcure) return;
    onSubmit(prompt);
  };

  return (
    <section aria-label="New procurement request" className="space-y-3">
      <div className="rounded-2xl bg-relay-gradient p-px">
        <div
          className={`rounded-[15px] bg-[#12161D] overflow-hidden transition-shadow ${
            isProcessing || disabled
              ? ''
              : 'focus-within:shadow-[0_0_0_3px_rgba(8,102,255,0.25)]'
          }`}
        >
        <label htmlFor="relay-command" className="sr-only">
          What do you need?
        </label>
        <textarea
          id="relay-command"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="I need 2 toothbrushes, 2 kg sugar, and 2 kg groundnut within 12 hours…"
          rows={compact ? 2 : 4}
          maxLength={5000}
          disabled={disabled || isProcessing}
          className={`w-full resize-y px-4 sm:px-5 py-3.5 sm:py-4 leading-relaxed text-relay-ink-900 placeholder:text-relay-ink-400 bg-transparent outline-none disabled:opacity-60 ${
            compact ? 'text-[15px] min-h-[72px]' : 'text-base min-h-[104px]'
          }`}
        />
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-5 py-2.5 border-t border-relay-surface-border bg-relay-surface-sunken/60">
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-relay-ink-500">
            <span className="inline-flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5 text-relay-ink-400" aria-hidden />
              Private request
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5 text-relay-ink-400" aria-hidden />
              Community matching
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Wallet className="h-3.5 w-3.5 text-relay-ink-400" aria-hidden />
              {mandateLimit !== null ? (
                <>
                  <strong className="tnum font-semibold text-relay-ink-900">
                    {formatMoneyCompact(mandateLimit, mandateCurrency)}
                  </strong>
                  mandate
                </>
              ) : (
                'Mandate-gated execution'
              )}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-relay-ink-400" aria-hidden />
              12-hour procurement SLA
            </span>
          </div>
          <Button
            variant="primary"
            size="md"
            onClick={submit}
            isLoading={isProcessing}
            disabled={disabled || !canProcure || value.trim().length === 0}
            className="shrink-0 w-full sm:w-auto"
            data-testid="ask-relay-button"
          >
            {isProcessing ? 'Starting mission…' : 'Ask Relay'}
            {!isProcessing && <ArrowRight className="h-4 w-4" aria-hidden />}
          </Button>
        </div>
        </div>
      </div>

      {anonymous && (
        <p className="text-sm text-relay-ink-600">
          <Link href="/login" className="font-semibold text-relay-primary-600 hover:underline">
            Sign in
          </Link>{' '}
          to send procurement requests. Relay only ever shows your own context.
        </p>
      )}
      {!anonymous && mandateMissing && (
        <p className="text-sm text-relay-ink-600">
          You need an active payment mandate before Relay can procure.{' '}
          <Link href="/onboarding" className="font-semibold text-relay-primary-600 hover:underline">
            Complete onboarding
          </Link>
          .
        </p>
      )}
    </section>
  );
}
