import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ResidentBillPayment } from '../components/ResidentBillPayment';
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
