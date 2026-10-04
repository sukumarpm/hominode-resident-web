import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { App } from '../App';
import { ResidentBillingStatementPage } from '../ResidentBillingStatementPage';
import {
  RESIDENT_BILLING_STATEMENT_ERROR,
  type ResidentBillingStatement,
} from '../residentBillingStatement';
import { AuthContext, type AuthState } from '../session';
import { APP_ROLE } from '../role';
import { makeSession } from './fixtures';

vi.mock('../firebase', () => ({
  call: vi.fn(async (name: string, payload: { slug?: string }) => ({
    communityId: 'community-1',
    slug: payload.slug,
    name: 'Green Valley',
  })),
  firebase: vi.fn(() => {
    throw Error('No live Firebase in statement page tests');
  }),
}));

vi.mock('../residentBillingStatement', async () => {
  const actual = await vi.importActual<typeof import('../residentBillingStatement')>(
    '../residentBillingStatement',
  );
  return { ...actual, getResidentBillingV2Statement: vi.fn() };
});

vi.mock('../data', async () => {
  const actual = await vi.importActual<typeof import('../data')>('../data');
  return { ...actual, useRows: vi.fn(() => ({ rows: [], loading: false, error: '' })) };
});

function statement(period: string, includeBill = true): ResidentBillingStatement {
  const bills: ResidentBillingStatement['bills'] = includeBill
    ? [
        {
          billId: 'bill-1',
          billingPeriod: period,
          amountMinor: 123456,
          paidAllocationMinor: 23456,
          creditAppliedMinor: 10000,
          outstandingMinor: 90000,
          status: 'partially_paid',
          dueDateKey: '2026-08-15',
          chargeLines: [
            {
              lineId: 'maintenance',
              code: 'maintenance',
              label: 'Maintenance',
              amountMinor: 123456,
            },
          ],
          settlements: [
            {
              transactionId: 'tx-1',
              method: 'bank_transfer',
              reference: 'BANK-55',
              receivedAt: 1785542400000,
              netAppliedMinor: 23456,
            },
          ],
        },
      ]
    : [];
  return {
    success: true,
    schemaVersion: 1,
    communityId: 'community-1',
    residentId: 'resident-1',
    billingPeriod: period,
    generatedAtMs: 1785542400000,
    summary: {
      billsCount: bills.length,
      billedMinor: includeBill ? 123456 : 0,
      paidAllocationMinor: includeBill ? 23456 : 0,
      creditAppliedMinor: includeBill ? 10000 : 0,
      outstandingMinor: includeBill ? 90000 : 0,
      availableCreditMinor: 500,
      statusCounts: {
        pending: 0,
        partially_paid: includeBill ? 1 : 0,
        paid: 0,
        overdue: 0,
      },
    },
    bills,
  };
}

function authState(session = makeSession('resident')): AuthState {
  return {
    session,
    loading: false,
    error: '',
    authenticated: true,
    signOut: vi.fn(async () => {}),
    switchCommunity: vi.fn(),
  };
}

function renderPage(
  loadStatement: (
    session: ReturnType<typeof makeSession>,
    period: string,
  ) => Promise<ResidentBillingStatement>,
  now = () => new Date(2026, 7, 20),
) {
  const session = makeSession('resident');
  return {
    session,
    ...render(
      <AuthContext value={authState(session)}>
        <ResidentBillingStatementPage loadStatement={loadStatement} now={now} />
      </AuthContext>,
    ),
  };
}

it('defaults to the current local month and renders the canonical summary with exact INR formatting', async () => {
  const loader = vi.fn(async (_session, period: string) => statement(period));
  renderPage(loader);

  expect(screen.getByRole('heading', { name: 'Monthly Statement' })).toBeInTheDocument();
  expect(screen.getByText('Billing and payment activity for your account.')).toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: 'Statement Summary' })).toBeInTheDocument();
  expect(
    within(screen.getByRole('region', { name: 'Statement month selector' })).getByRole(
      'heading',
      { name: 'August 2026' },
    ),
  ).toBeInTheDocument();
  expect(loader).toHaveBeenCalledWith(expect.anything(), '2026-08');
  expect(screen.getByText('Total billed')).toBeInTheDocument();
  expect(screen.getByText('Payments applied')).toBeInTheDocument();
  expect(screen.getAllByText('₹1,234.56')).toHaveLength(3);
  expect(screen.getAllByText('₹234.56')).toHaveLength(3);
  expect(screen.getAllByText('₹100.00')).toHaveLength(2);
  expect(screen.getAllByText('₹900.00')).toHaveLength(2);
});

it('renders October 2026 in the month navigator', async () => {
  renderPage(
    async (_session, period) => statement(period, false),
    () => new Date(2026, 9, 20),
  );

  expect(await screen.findByText('No bills for this month')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
});

it('renders all status counts and labels available credit as account-level current credit', async () => {
  renderPage(async (_session, period) => statement(period));
  await screen.findByRole('heading', { name: 'Statement Summary' });

  expect(screen.getByRole('heading', { name: 'Bill status' })).toBeInTheDocument();
  expect(screen.getByText('Pending')).toBeInTheDocument();
  expect(screen.getByText('Partially paid')).toBeInTheDocument();
  expect(screen.getByText('Paid')).toBeInTheDocument();
  expect(screen.getByText('Overdue')).toBeInTheDocument();
  expect(screen.getByText('Account-level current balance')).toBeInTheDocument();
  expect(screen.getByText('₹5.00')).toBeInTheDocument();
});

it('renders a bill Paid status in its status badge', async () => {
  const value = statement('2026-08');
  value.bills[0].status = 'paid';
  renderPage(async () => value);
  await screen.findByRole('heading', { name: 'Statement Summary' });

  expect(document.querySelector('.resident-statement-badge.status-paid')).toHaveTextContent('Paid');
});

it('renders charge lines, settlement method, net amount, received date and reference', async () => {
  renderPage(async (_session, period) => statement(period));
  await screen.findByRole('heading', { name: 'Statement Summary' });

  expect(screen.getByText('Maintenance')).toBeInTheDocument();
  expect(screen.getByText('Bank Transfer')).toBeInTheDocument();
  expect(screen.getByText('Received')).toBeInTheDocument();
  expect(screen.getByText(/Aug 1, 2026/)).toBeInTheDocument();
  expect(screen.getByText('BANK-55')).toBeInTheDocument();
  expect(screen.getByText('Due date')).toBeInTheDocument();
  expect(screen.getByText(/Aug 15, 2026/)).toBeInTheDocument();
});

it('omits a missing payment reference', async () => {
  const value = statement('2026-08');
  value.bills[0].settlements[0].reference = null;
  renderPage(async () => value);
  await screen.findByRole('heading', { name: 'Statement Summary' });

  expect(screen.queryByText('Payment reference')).not.toBeInTheDocument();
  expect(screen.queryByText('Not recorded')).not.toBeInTheDocument();
});

it('previous month requests the new period and clears old data while loading', async () => {
  let finishPrevious!: (value: ResidentBillingStatement) => void;
  const loader = vi.fn((_session, period: string) =>
    period === '2026-08'
      ? Promise.resolve(statement(period))
      : new Promise<ResidentBillingStatement>((resolve) => {
          finishPrevious = resolve;
        }),
  );
  renderPage(loader);
  await screen.findByRole('heading', { name: 'Statement Summary' });

  fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
  expect(screen.queryByText('₹1,234.56')).not.toBeInTheDocument();
  expect(await screen.findByRole('status')).toHaveTextContent('Loading statement');
  expect(loader).toHaveBeenLastCalledWith(expect.anything(), '2026-07');
  await act(async () => finishPrevious(statement('2026-07')));
  expect(await screen.findByRole('heading', { name: 'Statement Summary' })).toBeInTheDocument();
});

it('next month requests the next YYYY-MM including year rollover', async () => {
  const loader = vi.fn(async (_session, period: string) => statement(period, false));
  renderPage(loader, () => new Date(2026, 11, 10));
  await screen.findByText('No bills for this month');

  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));

  await waitFor(() => expect(loader).toHaveBeenLastCalledWith(expect.anything(), '2027-01'));
  expect(await screen.findByText('No bills for this month')).toBeInTheDocument();
});

it('failed month request does not retain old data or fabricate zero values', async () => {
  const loader = vi.fn(async (_session, period: string) => {
    if (period === '2026-07') throw new Error('raw private callable detail');
    return statement(period);
  });
  renderPage(loader);
  await screen.findByRole('heading', { name: 'Statement Summary' });
  fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(RESIDENT_BILLING_STATEMENT_ERROR);
  expect(screen.queryByText('₹1,234.56')).not.toBeInTheDocument();
  expect(screen.queryByText('₹0.00')).not.toBeInTheDocument();
  expect(screen.queryByText(/raw private callable detail/)).not.toBeInTheDocument();
  expect(screen.queryByText('Total billed')).not.toBeInTheDocument();
});

it('ignores older async responses after a newer selected month succeeds', async () => {
  let resolveInitialAugust!: (value: ResidentBillingStatement) => void;
  let resolveLatestAugust!: (value: ResidentBillingStatement) => void;
  let resolveJuly!: (value: ResidentBillingStatement) => void;
  let augustCalls = 0;

  const loader = vi.fn((_session, period: string) => {
    if (period === '2026-08') {
      augustCalls += 1;
      return new Promise<ResidentBillingStatement>((resolve) => {
        if (augustCalls === 1) {
          resolveInitialAugust = resolve;
        } else {
          resolveLatestAugust = resolve;
        }
      });
    }

    if (period === '2026-07') {
      return new Promise<ResidentBillingStatement>((resolve) => {
        resolveJuly = resolve;
      });
    }

    return Promise.resolve(statement(period));
  });

  renderPage(loader);

  await waitFor(() => expect(loader).toHaveBeenCalledWith(expect.anything(), '2026-08'));

  fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));

  await waitFor(() => expect(loader).toHaveBeenCalledWith(expect.anything(), '2026-07'));

  await act(async () => resolveJuly(statement('2026-07')));

  expect(await screen.findByRole('heading', { name: 'Statement Summary' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));

  await waitFor(() => expect(loader).toHaveBeenCalledTimes(3));

  const latestAugust = statement('2026-08');
  latestAugust.summary.availableCreditMinor = 22200;

  await act(async () => resolveLatestAugust(latestAugust));

  expect(await screen.findByText('₹222.00')).toBeInTheDocument();

  // The original August request now completes after the newer August request.
  // Its stale result must not replace the current statement.
  await act(async () => resolveInitialAugust(statement('2026-08')));

  expect(screen.getByText('₹222.00')).toBeInTheDocument();
  expect(screen.queryByText('₹5.00')).not.toBeInTheDocument();
});

it('shows current available credit for a successful zero-bill period', async () => {
  renderPage(async (_session, period) => statement(period, false));

  expect(await screen.findByText('No bills for this month')).toBeInTheDocument();
  expect(screen.getByText('Account-level current balance')).toBeInTheDocument();
  expect(screen.getByText('₹5.00')).toBeInTheDocument();
  expect(screen.getByText('Bill status')).toBeInTheDocument();
});

it('shows a bill-level empty settlement message when no payments were applied', async () => {
  const value = statement('2026-08');
  value.bills[0].settlements = [];
  renderPage(async () => value);
  await screen.findByRole('heading', { name: 'Statement Summary' });

  expect(screen.getByText('No payments applied to this bill yet.')).toBeInTheDocument();
});

it('offers retry and successfully loads the selected statement again', async () => {
  const loader = vi
    .fn<
      (session: ReturnType<typeof makeSession>, period: string) => Promise<ResidentBillingStatement>
    >()
    .mockRejectedValueOnce(new Error('callable failed'))
    .mockImplementation(async (_session, period) => statement(period, false));
  renderPage(loader);
  expect(await screen.findByRole('alert')).toHaveTextContent(RESIDENT_BILLING_STATEMENT_ERROR);

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

  expect(await screen.findByText('No bills for this month')).toBeInTheDocument();
  expect(loader).toHaveBeenCalledTimes(2);
});

it('has no PDF or CSV export controls', async () => {
  renderPage(async (_session, period) => statement(period));
  await screen.findByRole('heading', { name: 'Statement Summary' });

  expect(screen.queryByRole('button', { name: /PDF|CSV/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /PDF|CSV/i })).not.toBeInTheDocument();
});

it('keeps Payments and adds a Monthly Statement route from Bills & Payments', async () => {
  const { getResidentBillingV2Statement } = await import('../residentBillingStatement');
  vi.mocked(getResidentBillingV2Statement).mockImplementation(async (_session, period) =>
    statement(period, false),
  );
  const value = authState(makeSession(APP_ROLE));
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <AuthContext value={value}>
            <App />
          </AuthContext>
        ),
      },
    ],
    { initialEntries: ['/green-valley/bills'] },
  );
  render(<RouterProvider router={router} />);

  expect(await screen.findByRole('heading', { name: 'Bills & Payments' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Payments' })).toHaveAttribute(
    'href',
    '/green-valley/payments',
  );
  expect(screen.getByRole('link', { name: /Monthly Statement/ })).toHaveAttribute(
    'href',
    '/green-valley/statement',
  );
  fireEvent.click(screen.getByRole('link', { name: /Monthly Statement/ }));

  expect(await screen.findByRole('heading', { name: 'Monthly Statement' })).toBeInTheDocument();
  expect(await screen.findByText('No bills for this month')).toBeInTheDocument();
  expect(vi.mocked(getResidentBillingV2Statement)).toHaveBeenCalled();
});
