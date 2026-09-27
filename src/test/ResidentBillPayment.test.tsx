import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ResidentBillPayment } from '../components/ResidentBillPayment';
import { paymentAttributionLabel, paymentMethodLabel } from '../models';
import { makeSession } from './fixtures';

const paymentActions = vi.hoisted(() => ({
  prepare: vi.fn(),
  submit: vi.fn(),
  latest: vi.fn(),
}));

vi.mock('../actions', () => ({
  prepareDirectUpiPayment: paymentActions.prepare,
  submitProof: paymentActions.submit,
  latestPaymentForBill: paymentActions.latest,
}));

beforeEach(() => {
  vi.clearAllMocks();
  paymentActions.prepare.mockResolvedValue({
    billId: 'bill-1',
    amount: 1200.5,
    vpa: 'greenvalley@okaxis',
    payeeName: 'Green Valley Society',
    paymentUri: 'upi://pay?pa=greenvalley%40okaxis&pn=Green+Valley+Society&am=1200.50&cu=INR',
  });
});

it('shows a local QR modal with the server-prepared payee, VPA and exact amount', async () => {
  render(
    <ResidentBillPayment
      session={makeSession()}
      billId="bill-1"
      bill={{ status: 'pending', amount: 1 }}
      latestPayment={null}
      loading={false}
      onPaymentUpdated={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Pay via UPI' }));
  expect(paymentActions.prepare).toHaveBeenCalledWith(expect.anything(), 'bill-1');
  expect(await screen.findByRole('dialog', { name: 'Pay via UPI' })).toBeInTheDocument();
  expect(screen.getByText('Scan using any UPI app on your phone.')).toBeInTheDocument();
  expect(screen.getByText('Green Valley Society')).toBeInTheDocument();
  expect(screen.getByText('greenvalley@okaxis')).toBeInTheDocument();
  expect(screen.getByText('₹1200.50')).toBeInTheDocument();
  expect(screen.getByRole('dialog').querySelector('svg')).toBeInTheDocument();
});

it('routes a rejected proof directly to resubmission without opening the QR flow', async () => {
  render(
    <ResidentBillPayment
      session={makeSession()}
      billId="bill-1"
      bill={{ status: 'overdue', amount: 100 }}
      latestPayment={{ status: 'failed', rejectionReason: 'Receipt is unreadable' }}
      loading={false}
      onPaymentUpdated={vi.fn()}
    />,
  );

  expect(screen.getByText('Receipt is unreadable')).toBeInTheDocument();
  expect(screen.getByLabelText('Payment receipt image')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Resubmit payment proof' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Pay via UPI' })).not.toBeInTheDocument();
  expect(paymentActions.prepare).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('shows Direct UPI and informational Cash choices for an eligible bill', () => {
  render(
    <ResidentBillPayment
      session={makeSession()}
      billId="bill-1"
      bill={{ status: 'pending', amount: 100 }}
      latestPayment={null}
      loading={false}
      onPaymentUpdated={vi.fn()}
    />,
  );

  expect(screen.getByRole('heading', { name: 'Direct UPI' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Cash' })).toBeInTheDocument();
  expect(screen.getByText('Pay cash directly to your community office.')).toBeInTheDocument();
  expect(
    screen.getByText(
      'Your bill will be marked paid only after the Admin receives and records the payment.',
    ),
  ).toBeInTheDocument();
});

it('interacting with Cash is informational and makes no payment or Firebase action calls', () => {
  render(
    <ResidentBillPayment
      session={makeSession()}
      billId="bill-1"
      bill={{ status: 'overdue', amount: 100 }}
      latestPayment={null}
      loading={false}
      onPaymentUpdated={vi.fn()}
    />,
  );

  const cashChoice = screen.getByRole('heading', { name: 'Cash' }).closest('article');
  expect(cashChoice).not.toBeNull();
  expect(cashChoice?.querySelector('input[type="file"]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'How Cash payments work' }));
  expect(screen.getByRole('status')).toHaveTextContent('No receipt upload or online settlement');
  expect(paymentActions.prepare).not.toHaveBeenCalled();
  expect(paymentActions.submit).not.toHaveBeenCalled();
  expect(paymentActions.latest).not.toHaveBeenCalled();
});

it('shows pending Direct UPI proof and Admin review clearly', () => {
  render(
    <ResidentBillPayment
      session={makeSession()}
      billId="bill-1"
      bill={{ status: 'pending', amount: 100 }}
      latestPayment={{ method: 'upi', provider: 'direct_upi', status: 'pending' }}
      loading={false}
      onPaymentUpdated={vi.fn()}
    />,
  );

  expect(screen.getByText('UPI / Direct UPI')).toBeInTheDocument();
  expect(screen.getByText('Pending review')).toBeInTheDocument();
  expect(screen.getByText('Admin verification is pending.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Pay via UPI' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Cash' })).toBeInTheDocument();
});

it('labels a legacy External latest payment as External', () => {
  render(
    <ResidentBillPayment
      session={makeSession()}
      billId="bill-1"
      bill={{ status: 'pending', amount: 100 }}
      latestPayment={{ method: 'external', status: 'pending' }}
      loading={false}
      onPaymentUpdated={vi.fn()}
    />,
  );

  expect(screen.getByText('External')).toBeInTheDocument();
  expect(screen.queryByText('UPI / Direct UPI')).not.toBeInTheDocument();
});

it.each([
  ['cash', 'Cash', 'Recorded by Admin'],
  ['upi', 'UPI', 'Verified by Admin'],
  ['bank_transfer', 'Bank Transfer', 'Recorded by Admin'],
  ['cheque', 'Cheque', 'Recorded by Admin'],
] as const)(
  'shows paid %s settlement from authoritative bill fields',
  (method, label, settlement) => {
    const paidAt = new Date('2025-02-03T04:05:00.000Z');
    render(
      <ResidentBillPayment
        session={makeSession()}
        billId="bill-1"
        bill={{
          status: 'paid',
          paymentMethod: method,
          paymentReference: 'REF-123',
          paidAt,
          settledBy: 'private-settled-uid',
          reviewedBy: 'private-reviewed-uid',
        }}
        latestPayment={{ status: 'pending', settledBy: 'private-latest-uid' }}
        loading={false}
        onPaymentUpdated={vi.fn()}
      />,
    );

    expect(screen.getByText('Paid via')).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(settlement)).toBeInTheDocument();
    expect(screen.getByText('REF-123')).toBeInTheDocument();
    expect(screen.getByText('Paid on')).toBeInTheDocument();
    expect(screen.getByText(/2025|Feb|03/)).toBeInTheDocument();
    expect(screen.queryByText(/private-.*-uid/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Pay via UPI|Cash payment/i }),
    ).not.toBeInTheDocument();
  },
);

it('treats paid bill settlement fields as authoritative over a pending latest proof', () => {
  render(
    <ResidentBillPayment
      session={makeSession()}
      billId="bill-1"
      bill={{ status: 'pending', paidAmount: 120, paymentMethod: 'cash' }}
      latestPayment={{ status: 'pending' }}
      loading={false}
      onPaymentUpdated={vi.fn()}
    />,
  );

  expect(screen.getByText('Payment status')).toBeInTheDocument();
  expect(screen.getByText('Cash')).toBeInTheDocument();
  expect(screen.queryByText('Payment proof:')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Pay via UPI' })).not.toBeInTheDocument();
});

it('uses legacy transactionId when a paid bill has no paymentReference', () => {
  render(
    <ResidentBillPayment
      session={makeSession()}
      billId="bill-1"
      bill={{ status: 'paid', paymentMethod: 'upi', transactionId: 'LEGACY-REF-25' }}
      latestPayment={null}
      loading={false}
      onPaymentUpdated={vi.fn()}
    />,
  );

  expect(screen.getByText('Payment reference')).toBeInTheDocument();
  expect(screen.getByText('LEGACY-REF-25')).toBeInTheDocument();
});

it('formats legacy Manual and External methods without inventing settlement attribution', () => {
  expect(paymentMethodLabel('manual')).toBe('Manual');
  expect(paymentMethodLabel('external')).toBe('External');
  expect(paymentAttributionLabel('manual')).toBe('Recorded by Admin');
  expect(paymentAttributionLabel('external')).toBe('');
});
