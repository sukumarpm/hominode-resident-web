import { describe, expect, it, vi } from 'vitest';
import { makeSession } from './fixtures';
import {
  getResidentBillingV2Receipt,
  RESIDENT_BILLING_V2_RECEIPT_CALLABLE,
  RESIDENT_BILLING_V2_RECEIPT_ERROR,
} from '../residentBillingV2Receipt';

function response(transactionId = 'tx-partial') {
  return {
    success: true,
    schemaVersion: 1,
    receiptId: `HOMINODE-V2-${transactionId}`,
    transactionId,
    community: { communityId: 'community-1', name: 'Green Valley', address: 'Main Road' },
    currency: 'INR',
    method: 'upi',
    paymentReference: 'UPI-REF-1',
    receivedAt: 1785542400000,
    moneyReceivedMinor: 1250,
    confirmedAmountMinor: 1250,
    claimedAmountMinor: 1200,
    amountMismatch: true,
    confirmation: { status: 'verified', verifiedAt: 1785542401000, verifiedBy: 'Community Admin' },
    allocations: [{ billId: 'private-bill-id', amountMinor: 1000, allocatedAt: 1785542400000 }],
    allocatedAmountMinor: 1000,
    excessCreditMinor: 250,
    reconciliation: {
      confirmedAmountMinor: 1250,
      allocatedAmountMinor: 1000,
      excessCreditMinor: 250,
    },
    accountingBasis: {
      amountsAreMinorUnits: true,
      allocationsAreFromThisPayment: true,
      existingCreditApplicationsExcluded: true,
    },
    snapshot: 'original_settlement',
    laterAdjustments: { reversedAllocationMinor: 100, revisionCreditIssuedMinor: 100 },
  };
}

describe('resident Billing V2 receipt contract', () => {
  it('requests a verified transaction and separates confirmed amount, allocations, credit and later revisions', async () => {
    const invokeCall = vi.fn(async () => response());
    const receipt = await getResidentBillingV2Receipt(makeSession('resident'), 'tx-partial', {
      resolveAuthority: async (session) => session,
      invokeCall,
    });

    expect(invokeCall).toHaveBeenCalledWith(RESIDENT_BILLING_V2_RECEIPT_CALLABLE, {
      transactionId: 'tx-partial',
    });
    expect(receipt.moneyReceivedMinor).toBe(1250);
    expect(receipt.claimedAmountMinor).toBe(1200);
    expect(receipt.allocatedAmountMinor).toBe(1000);
    expect(receipt.excessCreditMinor).toBe(250);
    expect(receipt.reversedAllocationMinor).toBe(100);
    expect(receipt.allocations[0]).not.toHaveProperty('billId');
  });

  it('keeps each partial payment on its own deterministic receipt', async () => {
    const first = await getResidentBillingV2Receipt(makeSession('resident'), 'tx-partial', {
      resolveAuthority: async (session) => session,
      invokeCall: async (_name, { transactionId }) => response(String(transactionId)),
    });
    const second = await getResidentBillingV2Receipt(makeSession('resident'), 'tx-partial-2', {
      resolveAuthority: async (session) => session,
      invokeCall: async (_name, { transactionId }) => response(String(transactionId)),
    });
    expect(first.receiptId).not.toBe(second.receiptId);
  });

  it.each([
    [
      'unverified status',
      (value: ReturnType<typeof response>) => {
        value.confirmation.status = 'pending';
      },
    ],
    [
      'overpayment reconciliation mismatch',
      (value: ReturnType<typeof response>) => {
        value.excessCreditMinor = 251;
      },
    ],
    [
      'non-integer paise',
      (value: ReturnType<typeof response>) => {
        value.moneyReceivedMinor = 12.5;
      },
    ],
    [
      'wrong transaction',
      (value: ReturnType<typeof response>) => {
        value.transactionId = 'other';
      },
    ],
    [
      'wrong community',
      (value: ReturnType<typeof response>) => {
        value.community.communityId = 'other-community';
      },
    ],
    [
      'mismatch without a resident claim',
      (value: ReturnType<typeof response>) => {
        Object.assign(value, { claimedAmountMinor: null });
      },
    ],
  ])('rejects malformed receipt response: %s', async (_label, corrupt) => {
    const payload = response();
    corrupt(payload);
    await expect(
      getResidentBillingV2Receipt(makeSession('resident'), 'tx-partial', {
        resolveAuthority: async (session) => session,
        invokeCall: async () => payload,
      }),
    ).rejects.toThrow(RESIDENT_BILLING_V2_RECEIPT_ERROR);
  });

  it('fails closed when resident authority cannot be verified', async () => {
    const invokeCall = vi.fn();
    await expect(
      getResidentBillingV2Receipt(makeSession('resident'), 'tx-partial', {
        resolveAuthority: async () => ({ ...makeSession('resident'), uid: 'other-resident' }),
        invokeCall,
      }),
    ).rejects.toThrow(RESIDENT_BILLING_V2_RECEIPT_ERROR);
    expect(invokeCall).not.toHaveBeenCalled();
  });
});
