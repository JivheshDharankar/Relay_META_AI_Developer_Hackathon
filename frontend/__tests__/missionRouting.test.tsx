import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import MissionPage from '@/app/mission/page';
import CommandCenterPage from '@/app/page';
import ProcurementPage from '@/app/procurement/page';
import QuotesPage from '@/app/quotes/page';
import { NAV_SECTIONS } from '@/components/shell/AppShell';
import { IDLE_RUN } from '@/lib/workflow/types';

const pushMock = vi.fn();

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
});

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

let sessionRun: typeof IDLE_RUN = { ...IDLE_RUN };
const startMock = vi.fn();
vi.mock('@/lib/workflow/MissionSessionContext', () => ({
  useMissionSession: () => ({
    get run() {
      return sessionRun;
    },
    start: startMock,
    reset: vi.fn(),
    isProcessing: sessionRun.status === 'processing',
    isFailed: false,
    demoMode: false,
    setDemoMode: vi.fn(),
  }),
}));

vi.mock('@/lib/workflow/runStore', () => ({
  useRunStore: () => ({ recordRun: vi.fn(), latestRun: null, runs: [], ready: true }),
  RunStoreProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe('mission routing', () => {
  it('idle /mission shows the empty state on the mission URL (no redirect)', () => {
    sessionRun = { ...IDLE_RUN };
    render(<MissionPage />);
    expect(screen.getByRole('status', { name: 'No active mission' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Go to Command Center' })).toHaveProperty(
      'href',
      expect.stringContaining('/')
    );
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('active /mission renders the full mission experience', () => {
    sessionRun = { ...IDLE_RUN, status: 'processing', prompt: '2 kg rice' };
    render(<MissionPage />);
    expect(screen.getByRole('main', { name: 'Relay Autonomous Mission Control' })).toBeDefined();
    expect(screen.getByText(/2 kg rice/)).toBeDefined();
  });

  it('command submit starts the mission and navigates to /mission', () => {
    sessionRun = { ...IDLE_RUN };
    startMock.mockClear();
    pushMock.mockClear();
    render(<CommandCenterPage />);
    fireEvent.click(screen.getByRole('button', { name: /run demo mission/i }));
    expect(startMock).toHaveBeenCalledWith('2 kg rice, 1 kg sugar and 2 packs Maggi');
    expect(pushMock).toHaveBeenCalledWith('/mission');
  });
});

describe('sidebar destinations are real routes', () => {
  it('exposes Mission, Procurement, and top-level Quotes destinations', () => {
    const hrefs = NAV_SECTIONS.flatMap((s) => s.items.map((i) => `${i.name} ${i.href}`));
    expect(hrefs).toContain('Mission /mission');
    expect(hrefs).toContain('Procurement /procurement');
    expect(hrefs).toContain('Quotes /quotes');
  });

  it('/procurement links to the four real procurement surfaces', () => {
    render(<ProcurementPage />);
    for (const href of ['/market', '/quotes', '/orders', '/suppliers']) {
      const links = screen.getAllByRole('link').map((a) => (a as HTMLAnchorElement).getAttribute('href'));
      expect(links).toContain(href);
    }
  });

  it('/quotes renders the shared quotes workspace', () => {
    render(<QuotesPage />);
    expect(screen.getByText('No quotes yet')).toBeDefined();
  });
});
