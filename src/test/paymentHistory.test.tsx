import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  combineResidentPaymentResources,
  mergeResidentPaymentRows,
  querySpec,
  residentV2PaymentRow,
  type Resource,
} from '../data';
import { type Data, type Row, type Session } from '../models';
import { ModulePage } from '../pages';
import { AuthContext, type AuthState } from '../session';
import { makeSession } from './fixtures';

const mocks = vi.hoisted(() => ({
  listeners: [] as {
    target: { name: string };
    constraints: unknown[];
    next: (value: unknown) => void;
    error: (error: Error) => void;
    stop: ReturnType<typeof vi.fn>;
  }[],
}));

vi.mock('../firebase', () => ({ firebase: () => ({ db: {} }), call: vi.fn() }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db, name) => ({ name })),
  doc: vi.fn(),
  documentId: () => '__name__',
  query: vi.fn((target, ...constraints) => ({ target, constraints })),
  where: vi.fn((...args) => args),
  onSnapshot: vi.fn((queryValue, next, error) => {
    const listener = {
      target: queryValue.target,
      constraints: queryValue.constraints,
      next,
      error,
      stop: vi.fn(),
    };
    mocks.listeners.push(listener);
    return listener.stop;
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.length = 0;
});

const resident = makeSession();
const receivedAtMs = Date.UTC(2026, 8, 3, 8, 30);
const transaction = (id: string, overrides: Data = {}): Data => ({
  schemaVersion: 2,
  transactionId: id,
  communityId: 'community-1',
  residentId: 'resident-1',
  currency: 'INR',
  amountMinor: 100,
  method: 'upi',
  reference: 'UPI-REF-1',
  receivedAt: receivedAtMs,
  ...overrides,
});

function mountPayments(session: Session = resident) {
  const auth: AuthState = {
    session,
    loading: false,
    error: '',
    authenticated: true,
    signOut: vi.fn(),
    switchCommunity: vi.fn(),
  };
  return render(
    <AuthContext value={auth}>
      <MemoryRouter initialEntries={['/green-valley/payments']}>
        <ModulePage module="payments" />
      </MemoryRouter>
    </AuthContext>,
  );
}

function listenerFor(name: string) {
  const listener = mocks.listeners.find((entry) => entry.target.name === name);
  if (!listener) throw Error(`Missing ${name} listener.`);
  return listener;
}

function emit(name: string, entries: Array<{ id: string; data: Data }>) {
  act(() =>
    listenerFor(name).next({
      docs: entries.map(({ id, data }) => ({ id, data: () => data })),
    }),
  );
}

function legacyPayment(overrides: Data = {}): Data {
  return {
    communityId: 'community-1',
    flatId: 'unit-1',
    userId: 'resident-1',
    method: 'cash',
    status: 'completed',
    amount: 1,
    createdAt: new Date('2026-09-02T08:30:00.000Z'),
    ...overrides,
  };
}

it('leaves the legacy resident Payments query unchanged and scoped', () => {
  expect(querySpec(resident, 'payments')).toEqual({
    collection: 'payments',
    filters: [
      ['communityId', '==', 'community-1'],
      ['flatId', '==', 'unit-1'],
      ['userId', '==', 'resident-1'],
    ],
  });
});

it('validates canonical resident transactions and normalizes only display fields', () => {
  const row = residentV2PaymentRow('txn-1', transaction('txn-1'), 'community-1', 'resident-1');
  expect(row).toEqual({
    id: 'txn-1',
    source: 'residentBillingV2Payment',
    data: {
      transactionId: 'txn-1',
      schemaVersion: 2,
      currency: 'INR',
      amountMinor: 100,
      method: 'upi',
      status: 'completed',
      recordedAt: new Date(receivedAtMs),
      paymentReference: 'UPI-REF-1',
    },
  });
  expect(residentV2PaymentRow('txn-1', transaction('txn-1', { reference: null }), 'community-1', 'resident-1')?.data).not.toHaveProperty('paymentReference');
  const fallbackMs = Date.UTC(2026, 8, 1, 0, 0);
  expect(
    residentV2PaymentRow(
      'txn-1',
      transaction('txn-1', {
        reference: undefined,
        receivedAt: undefined,
        createdAt: fallbackMs,
      }),
      'community-1',
      'resident-1',
    )?.data.recordedAt,
  ).toEqual(new Date(fallbackMs));
  expect(residentV2PaymentRow('txn-1', transaction('txn-1', { reference: ' UPI-REF-1 ' }), 'community-1', 'resident-1')).toBeNull();
});

it.each([
  ['malformed schema', { schemaVersion: 1 }],
  ['document id mismatch', { transactionId: 'different-id' }],
  ['explicit id mismatch', { id: 'different-id' }],
  ['wrong community', { communityId: 'community-2' }],
  ['wrong resident', { residentId: 'resident-2' }],
  ['non-INR currency', { currency: 'USD' }],
  ['unsafe amount', { amountMinor: Number.MAX_SAFE_INTEGER + 1 }],
  ['zero amount', { amountMinor: 0 }],
  ['fractional amount', { amountMinor: 1.5 }],
  ['unsupported payment method', { method: 'external' }],
  ['negative receivedAt', { receivedAt: -1 }],
  ['fractional receivedAt', { receivedAt: receivedAtMs + 0.5 }],
  ['unsafe receivedAt', { receivedAt: Number.MAX_SAFE_INTEGER + 1 }],
  ['out-of-Date-range receivedAt', { receivedAt: 8_640_000_000_000_001 }],
  ['negative createdAt', { receivedAt: undefined, createdAt: -1 }],
  ['invalid createdAt despite valid receivedAt', { createdAt: -1 }],
  ['fractional createdAt', { receivedAt: undefined, createdAt: 10.5 }],
  ['out-of-Date-range createdAt', { receivedAt: undefined, createdAt: 8_640_000_000_000_001 }],
  ['missing canonical timestamps', { receivedAt: undefined, createdAt: undefined }],
])('rejects a V2 transaction with %s', (_label, overrides) => {
  expect(
    residentV2PaymentRow('txn-1', transaction('txn-1', overrides), 'community-1', 'resident-1'),
  ).toBeNull();
});

it('merges legacy and V2 rows with collision-safe IDs and newest-first ordering', () => {
  const legacy: Row = {
    id: 'billing-v2-transaction:txn-1',
    data: legacyPayment({ createdAt: new Date('2026-09-02T08:30:00.000Z') }),
  };
  const v2 = residentV2PaymentRow(
    'txn-1',
    transaction('txn-1'),
    'community-1',
    'resident-1',
  )!;
  const olderV2: Row = {
    ...residentV2PaymentRow(
      'txn-older',
      transaction('txn-older', {
        receivedAt: undefined,
        createdAt: Date.UTC(2026, 8, 1, 8, 30),
      }),
      'community-1',
      'resident-1',
    )!,
  };
  const merged = mergeResidentPaymentRows([legacy], [olderV2, v2]);
  expect(merged).toHaveLength(3);
  expect(new Set(merged.map((row) => row.id)).size).toBe(3);
  expect(merged[0].data.transactionId).toBe('txn-1');
  expect(merged[1]).toEqual(legacy);
  expect(merged[2].data.transactionId).toBe('txn-older');
});

it('waits for both resident history sources and surfaces either source error', () => {
  const loading: Resource = { rows: [], loading: true, error: '' };
  const empty: Resource = { rows: [], loading: false, error: '' };
  expect(combineResidentPaymentResources(empty, loading)).toEqual(loading);
  expect(
    combineResidentPaymentResources(empty, { rows: [], loading: false, error: 'V2 denied' }),
  ).toEqual({ rows: [], loading: false, error: 'V2 denied' });
  expect(
    combineResidentPaymentResources({ rows: [], loading: false, error: 'V1 denied' }, empty),
  ).toEqual({ rows: [], loading: false, error: 'V1 denied' });
});

it('renders legacy-only resident history unchanged', () => {
  mountPayments();
  emit('payments', [{ id: 'legacy-1', data: legacyPayment() }]);
  emit('paymentTransactions', []);
  expect(screen.getByText('1', { selector: 'strong' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Details' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /View details/ }));
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByRole('heading', { name: 'Payment details' })).toBeInTheDocument();
});

it('renders a V2 UPI payment of ₹1.00 and its actual reference in details', () => {
  mountPayments();
  emit('payments', []);
  emit('paymentTransactions', [{ id: 'txn-1', data: transaction('txn-1') }]);
  expect(screen.getByRole('heading', { name: 'txn-1' })).toBeInTheDocument();
  expect(screen.getByText('₹1.00 · UPI')).toBeInTheDocument();
  expect(
    screen.getByText(
      new Date(receivedAtMs).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    ),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /View details/ }));
  const paymentDialog = screen.getByRole('dialog');
  expect(paymentDialog).toHaveClass('payment-details-dialog');
  const dialog = within(paymentDialog);
  expect(dialog.getByRole('heading', { name: 'Payment details' })).toBeInTheDocument();
  expect(dialog.getByText('txn-1')).toBeInTheDocument();
  expect(dialog.getByText('Payment method')).toBeInTheDocument();
  expect(dialog.getByText('UPI')).toBeInTheDocument();
  expect(dialog.getByText('UPI-REF-1')).toBeInTheDocument();
  expect(dialog.getByText('Completed')).toBeInTheDocument();
  expect(dialog.getByText('Verified by Admin')).toBeInTheDocument();
});

it('does not fabricate a reference when a canonical transaction has none', () => {
  mountPayments();
  emit('payments', []);
  emit('paymentTransactions', [
    { id: 'txn-no-ref', data: transaction('txn-no-ref', { reference: null }) },
  ]);
  fireEvent.click(screen.getByRole('button', { name: /View details/ }));
  expect(screen.getByText('Transaction ID')).toBeInTheDocument();
  expect(screen.queryByText('Payment reference')).not.toBeInTheDocument();
  expect(screen.getAllByText('txn-no-ref')).toHaveLength(2);
});

it('merges V1 and V2 payments when their document IDs collide', () => {
  mountPayments();
  emit('payments', [{ id: 'txn-1', data: legacyPayment({ transactionId: 'V1-REF' }) }]);
  emit('paymentTransactions', [{ id: 'txn-1', data: transaction('txn-1') }]);
  expect(screen.getByText('2', { selector: 'strong' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'txn-1' })).toBeInTheDocument();
});

it('keeps the loading state until both sources respond and shows V2 listener errors', () => {
  mountPayments();
  expect(screen.getByRole('status', { name: 'Loading information' })).toBeInTheDocument();
  emit('payments', []);
  expect(screen.getByRole('status', { name: 'Loading information' })).toBeInTheDocument();
  act(() => listenerFor('paymentTransactions').error(Error('V2 access denied')));
  expect(screen.getByRole('alert')).toHaveTextContent('V2 access denied');
  expect(screen.queryByText('No payments to display yet.')).not.toBeInTheDocument();
});

it('fails the whole V2 history when one transaction is malformed', () => {
  mountPayments();
  emit('payments', []);
  emit('paymentTransactions', [
    { id: 'txn-valid', data: transaction('txn-valid') },
    { id: 'txn-invalid', data: transaction('txn-invalid', { amountMinor: 0 }) },
  ]);
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Billing V2 payment history could not be validated.',
  );
  expect(screen.queryByRole('heading', { name: 'txn-valid' })).not.toBeInTheDocument();
  expect(screen.queryByText('No payments to display yet.')).not.toBeInTheDocument();
});

it('does not query canonical V2 payment history for administrators', () => {
  mountPayments(makeSession('admin'));
  expect(mocks.listeners.map((listener) => listener.target.name)).toEqual(['payments']);
});

it('queries V2 history only by the current community and authenticated resident', () => {
  mountPayments();
  const v2 = listenerFor('paymentTransactions');
  expect(v2.constraints).toEqual([
    ['communityId', '==', 'community-1'],
    ['residentId', '==', 'resident-1'],
  ]);
});
