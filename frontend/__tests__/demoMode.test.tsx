import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AutonomousMissionControl } from '@/components/mission/AutonomousMissionControl';
import CommandCenterPage from '@/app/page';
import { IDLE_RUN, type ProcurementRun } from '@/lib/workflow/types';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
}));

vi.mock('@/lib/session/SessionContext', () => ({
  useSession: () => ({
    status: 'authenticated',
    session: null,
    error: null,
    refresh: vi.fn(),
    signOut: vi.fn(),
    markUnauthorized: vi.fn(),
  }),
}));

vi.mock('@/lib/session/useResidentContext', () => ({
  useResidentContext: () => ({
    profile: { societyName: 'Demo Society', flatNumber: 'B-2', activeMandate: null },
    payments: null,
    mandate: { maximumAmount: 10000, currency: 'INR', status: 'ACTIVE' },
    paymentsTrusted: false,
    loading: false,
    error: null,
    unauthorized: false,
    reload: vi.fn(),
  }),
}));

const startMock = vi.fn();
vi.mock('@/lib/workflow/MissionSessionContext', () => ({
  useMissionSession: () => ({
    run: { status: 'idle', prompt: '', error: null },
    start: startMock,
    reset: vi.fn(),
    isProcessing: false,
    isFailed: false,
    demoMode: false,
    setDemoMode: vi.fn(),
  }),
}));

vi.mock('@/lib/workflow/runStore', () => ({
  useRunStore: () => ({ recordRun: vi.fn(), latestRun: null, runs: [] }),
  RunStoreProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Real-motion timers: normal mode cascades, so anything instant must come from demoMode.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
});

function toolStep(name: string, result: unknown) {
  return {
    step: 1,
    toolCall: { id: `call_${name}`, name, arguments: {}, result, durationMs: 1 },
  };
}

function completeRun(): ProcurementRun {
  const agentResponse = {
    success: true,
    runId: 'run-demo-1',
    response: 'done',
    steps: [
      toolStep('startWorkflow', { success: true, workflowId: 'wf_1' }),
      toolStep('getWorkflowState', {
        success: true,
        data: {
          entities: {
            supplierCandidateIds: ['a'],
            qualifiedSupplierIds: ['a'],
            receivedQuoteIds: ['q1'],
            negotiatedQuoteIds: ['q1'],
            paymentId: 'pmt_1',
            selectedQuoteId: 'q1',
          },
        },
      }),
      toolStep('getQuote', {
        success: true,
        quote: {
          id: 'q1',
          status: 'VALID',
          supplierName: 'Supplier A',
          lineItems: [{ productName: 'rice', quotedQuantity: 2, unit: 'kg', unitPrice: 100 }],
          subtotal: 200,
          tax: 10,
          deliveryFee: 20,
          otherCharges: 0,
          total: 230,
        },
      }),
      toolStep('getProcurementCommitment', {
        success: true,
        commitment: {
          id: 'commit_1',
          status: 'PAID',
          product: { productName: 'rice', unit: 'kg' },
          requestedQuantity: 2,
          allocations: [{ supplierName: 'Supplier A', totalAmount: 230, quoteId: 'q1', supplierId: 'a' }],
          financials: { total: 230, currency: 'INR' },
          deliveryDeadline: 'x',
          committedAt: 'x',
          commercialBasisSimulated: true,
        },
      }),
      toolStep('getReconciliationStatus', {
        success: true,
        status: 'RECONCILED',
        isQuantityMatched: true,
        isMonetaryMatched: true,
        isSupplierObligationsMatched: true,
        isPaymentVerified: true,
        discrepancyCount: 0,
        discrepancies: [],
      }),
      toolStep('getAllocationSummary', {
        success: true,
        totalRequestedQuantity: 2,
        totalAllocatedQuantity: 2,
        totalProcurementCost: 230,
        totalResidentAllocatedAmount: 230,
        residentCount: 1,
      }),
      toolStep('getFulfillmentState', {
        success: true,
        order: { id: 'ful_1', status: 'VERIFIED', trackingReference: 'TRK-1', purchaseOrderId: 'po_1', supplierName: 'Supplier A' },
      }),
    ],
  } as unknown as ProcurementRun['agentResponse'];
  return { ...IDLE_RUN, status: 'complete', prompt: '2 kg rice, 1 kg sugar and 2 packs Maggi', agentResponse };
}

function baseProps(run: ProcurementRun) {
  return {
    prompt: run.prompt,
    run,
    isProcessing: false,
    onReturnToCommandCenter: vi.fn(),
    onRetry: vi.fn(),
  };
}

describe('Demo mode presentation', () => {
  it('renders the 7-milestone journey from stage evidence', () => {
    render(<AutonomousMissionControl {...baseProps(completeRun())} demoMode />);
    for (const label of ['Understand', 'Discover', 'Quote/Negotiate', 'Select', 'Pay', 'Fulfill', 'Reconcile']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('shows Mission Complete immediately without waiting for the reveal cascade', () => {
    render(<AutonomousMissionControl {...baseProps(completeRun())} demoMode />);
    expect(screen.getByText('Mission Complete')).toBeDefined();
  });

  it('collapses the 13-stage rail into an expander', () => {
    const { container } = render(<AutonomousMissionControl {...baseProps(completeRun())} demoMode />);
    expect(screen.getByText('Full 13-stage proof timeline')).toBeDefined();
    expect(container.querySelector('details')).not.toBeNull();
  });

  it('normal mode keeps the cascade: summary not instant, no journey, no details', () => {
    const { container } = render(<AutonomousMissionControl {...baseProps(completeRun())} />);
    expect(screen.queryByText('Mission Complete')).toBeNull();
    expect(screen.queryByText('Quote/Negotiate')).toBeNull();
    expect(screen.queryByText('Full 13-stage proof timeline')).toBeNull();
    expect(container.querySelector('details')).toBeNull();
  });
});

describe('Demo one-click trigger', () => {
  it('submits the preselected fully-specified request in one click', async () => {
    startMock.mockClear();
    render(<CommandCenterPage />);
    const button = await screen.findByRole('button', { name: /run demo mission/i });
    fireEvent.click(button);
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledWith('2 kg rice, 1 kg sugar and 2 packs Maggi');
  });
});

describe('Homepage Suggestion Chips UX', () => {
  const suggestions = [
    'Find the best bulk deal for 100 kg of rice',
    'Compare suppliers for monthly cleaning supplies',
    'I need 2 kg rice and 1 kg sugar',
    'मुझे 3 किलो दूध चाहिए',
  ];

  it.each(suggestions)('clicking "%s" populates command input without auto-submitting', async (suggestion) => {
    startMock.mockClear();
    render(<CommandCenterPage />);
    const chipButton = await screen.findByRole('button', { name: suggestion });
    fireEvent.click(chipButton);

    const textarea = screen.getByRole('textbox', { name: /what do you need/i }) as HTMLTextAreaElement;
    expect(textarea.value).toBe(suggestion);
    // Crucial requirement: clicking chip must NOT auto-launch mission
    expect(startMock).not.toHaveBeenCalled();
  });

  it('allows editing populated text before submission', async () => {
    startMock.mockClear();
    render(<CommandCenterPage />);
    const chipButton = await screen.findByRole('button', { name: 'मुझे 3 किलो दूध चाहिए' });
    fireEvent.click(chipButton);

    const textarea = screen.getByRole('textbox', { name: /what do you need/i }) as HTMLTextAreaElement;
    expect(textarea.value).toBe('मुझे 3 किलो दूध चाहिए');

    // User edits the populated text
    fireEvent.change(textarea, { target: { value: 'मुझे 5 किलो दूध और 1 किलो मक्खन चाहिए' } });
    expect(textarea.value).toBe('मुझे 5 किलो दूध और 1 किलो मक्खन चाहिए');

    // Submits via form button
    const submitButton = screen.getByTestId('ask-relay-button');
    fireEvent.click(submitButton);

    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledWith('मुझे 5 किलो दूध और 1 किलो मक्खन चाहिए');
  });
});
