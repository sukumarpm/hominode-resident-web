import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { PaymentRecordFields, labels } from '../pages';

it('uses generic Payments terminology for the existing module route', () => {
  expect(labels.payments).toBe('Payments');
});

it('shows completed offline payments without inventing proof metadata or exposing UIDs', () => {
  render(
    <PaymentRecordFields
      data={{
        method: 'bank_transfer',
        status: 'completed',
        transactionId: 'BANK-REF-8',
        recordedAt: new Date('2025-01-02T03:04:00.000Z'),
        settledBy: 'private-settled-uid',
      }}
    />,
  );

  expect(screen.getByText('Bank Transfer')).toBeInTheDocument();
  expect(screen.getByText('BANK-REF-8')).toBeInTheDocument();
  expect(screen.getByText('Recorded by Admin')).toBeInTheDocument();
  expect(screen.queryByText('Provider')).not.toBeInTheDocument();
  expect(screen.queryByText('Evidence')).not.toBeInTheDocument();
  expect(screen.queryByText(/private-settled-uid/)).not.toBeInTheDocument();
});

it('keeps legacy external records readable without inventing UPI proof fields', () => {
  render(<PaymentRecordFields data={{ method: 'external', status: 'completed' }} />);

  expect(screen.getByText('External')).toBeInTheDocument();
  expect(screen.queryByText('Provider')).not.toBeInTheDocument();
  expect(screen.queryByText('Verification')).not.toBeInTheDocument();
  expect(screen.queryByText('Evidence')).not.toBeInTheDocument();
  expect(screen.queryByText('Settlement')).not.toBeInTheDocument();
});

it('does not describe a pending UPI proof as verified', () => {
  render(
    <PaymentRecordFields data={{ method: 'upi', provider: 'direct_upi', status: 'pending' }} />,
  );

  expect(screen.getByText('UPI')).toBeInTheDocument();
  expect(screen.getByText('Direct UPI')).toBeInTheDocument();
  expect(screen.queryByText('Verified by Admin')).not.toBeInTheDocument();
});

it('displays paymentReference when transactionId is absent', () => {
  render(
    <PaymentRecordFields
      data={{ method: 'cash', status: 'completed', paymentReference: 'CASH-REF-19' }}
    />,
  );

  expect(screen.getByText('CASH-REF-19')).toBeInTheDocument();
});
