import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import {
  getResidentBillingV2Statement,
  RESIDENT_BILLING_STATEMENT_CALLABLE,
  RESIDENT_BILLING_STATEMENT_ERROR,
  type ResidentBillingStatementDependencies,
} from '../residentBillingStatement';
import { makeSession } from './fixtures';

const session = makeSession('resident');

function validResponse() {
  return {
    success: true,
    schemaVersion: 1,
    communityId: 'community-1',
    residentId: 'resident-1',
    billingPeriod: '2026-08',
    generatedAtMs: 1785542400000,
    summary: {
      billsCount: 1,
      billedMinor: 10000,
      paidAllocationMinor: 3000,
      creditAppliedMinor: 2000,
      outstandingMinor: 5000,
      availableCreditMinor: 400,
      statusCounts: { pending: 0, partially_paid: 1, paid: 0, overdue: 0 },
    },
    bills: [
      {
        billId: 'bill-1',
        billingPeriod: '2026-08',
        amountMinor: 10000,
        paidAllocationMinor: 3000,
        creditAppliedMinor: 2000,
        outstandingMinor: 5000,
        status: 'partially_paid',
        dueDateKey: '2026-08-15',
        chargeLines: [
          { lineId: 'maintenance', code: 'maintenance', label: 'Maintenance', amountMinor: 10000 },
        ],
        settlements: [
          {
            transactionId: 'tx-1',
            method: 'upi',
            reference: 'UPI-123',
            receivedAt: 1785542400000,
            netAppliedMinor: 3000,
          },
        ],
      },
    ],
  };
}

function setup(
  response: unknown = validResponse(),
  overrides: Partial<ResidentBillingStatementDependencies> = {},
) {
  const invokeCall = vi.fn(async (name: string, payload: Record<string, unknown>) => {
    void name;
    void payload;
    return response;
  });
  const resolveAuthority = vi.fn(async (requestedSession: typeof session) => requestedSession);
  const dependencies = { resolveAuthority, invokeCall, ...overrides };
  return { invokeCall, resolveAuthority, dependencies };
}

it('invokes the exact trusted callable with only billingPeriod', async () => {
  const { invokeCall, dependencies } = setup();

  await getResidentBillingV2Statement(session, '2026-08', dependencies);

  expect(invokeCall).toHaveBeenCalledOnce();
  expect(invokeCall).toHaveBeenCalledWith(RESIDENT_BILLING_STATEMENT_CALLABLE, {
    billingPeriod: '2026-08',
  });
  expect(invokeCall.mock.calls[0][1]).toEqual({ billingPeriod: '2026-08' });
  expect(Object.keys(invokeCall.mock.calls[0][1])).toEqual(['billingPeriod']);
});

it('re-resolves current authority for every statement request', async () => {
  const { resolveAuthority, dependencies } = setup();

  await getResidentBillingV2Statement(session, '2026-08', dependencies);

  expect(resolveAuthority).toHaveBeenCalledExactlyOnceWith(session);
});

it('rejects admins and non-resident trusted profiles before the callable', async () => {
  const admin = makeSession('admin');
  const adminSetup = setup(validResponse(), {
    resolveAuthority: vi.fn(async () => admin),
  });
  await expect(
    getResidentBillingV2Statement(admin, '2026-08', adminSetup.dependencies),
  ).rejects.toThrow('Resident access could not be verified');
  expect(adminSetup.invokeCall).not.toHaveBeenCalled();

  const nonResident = {
    ...session,
    profile: { ...session.profile, role: 'admin' as const },
  };
  const profileSetup = setup(validResponse(), {
    resolveAuthority: vi.fn(async () => nonResident),
  });
  await expect(
    getResidentBillingV2Statement(session, '2026-08', profileSetup.dependencies),
  ).rejects.toThrow('Resident access could not be verified');
  expect(profileSetup.invokeCall).not.toHaveBeenCalled();

  const missingCommunity = { ...session, community: null };
  const communitySetup = setup(validResponse(), {
    resolveAuthority: vi.fn(async () => missingCommunity),
  });
  await expect(
    getResidentBillingV2Statement(session, '2026-08', communitySetup.dependencies),
  ).rejects.toThrow('Resident access could not be verified');
  expect(communitySetup.invokeCall).not.toHaveBeenCalled();
});

it('rejects invalid YYYY-MM values before invoking the callable', async () => {
  const { invokeCall, dependencies } = setup();
  for (const period of ['', '2026-00', '2026-13', '2026-8', '2026-08-01']) {
    await expect(getResidentBillingV2Statement(session, period, dependencies)).rejects.toThrow(
      'Choose a valid billing month',
    );
  }
  expect(invokeCall).not.toHaveBeenCalled();
});

it.each([
  ['residentId', (data: ReturnType<typeof validResponse>) => (data.residentId = 'someone-else')],
  [
    'communityId',
    (data: ReturnType<typeof validResponse>) => (data.communityId = 'other-community'),
  ],
  ['billingPeriod', (data: ReturnType<typeof validResponse>) => (data.billingPeriod = '2026-07')],
])('rejects response %s mismatch', async (_label, mutate) => {
  const data = validResponse();
  mutate(data);
  const { dependencies } = setup(data);
  await expect(getResidentBillingV2Statement(session, '2026-08', dependencies)).rejects.toThrow(
    RESIDENT_BILLING_STATEMENT_ERROR,
  );
});

it('fails closed on malformed schema and unsafe generatedAtMs', async () => {
  const missingSchema = validResponse() as Record<string, unknown>;
  delete missingSchema.schemaVersion;
  const unsafeGeneratedAt = validResponse();
  unsafeGeneratedAt.generatedAtMs = Number.MAX_SAFE_INTEGER + 1;
  for (const response of [missingSchema, unsafeGeneratedAt]) {
    const { dependencies } = setup(response);
    await expect(getResidentBillingV2Statement(session, '2026-08', dependencies)).rejects.toThrow(
      RESIDENT_BILLING_STATEMENT_ERROR,
    );
  }
});

it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10000'])(
  'rejects malformed summary monetary value %s',
  async (badValue) => {
    const response = validResponse();
    response.summary.billedMinor = badValue as number;
    const { dependencies } = setup(response);
    await expect(getResidentBillingV2Statement(session, '2026-08', dependencies)).rejects.toThrow(
      RESIDENT_BILLING_STATEMENT_ERROR,
    );
  },
);

it('rejects malformed bills and charge lines', async () => {
  const malformedBill = validResponse();
  malformedBill.bills[0].status = 'cancelled';
  const malformedChargeLine = validResponse();
  malformedChargeLine.bills[0].chargeLines[0].amountMinor = 9999;
  for (const response of [malformedBill, malformedChargeLine]) {
    const { dependencies } = setup(response);
    await expect(getResidentBillingV2Statement(session, '2026-08', dependencies)).rejects.toThrow(
      RESIDENT_BILLING_STATEMENT_ERROR,
    );
  }
});

it('rejects malformed settlements and unsupported settlement methods', async () => {
  const badSettlement = validResponse();
  badSettlement.bills[0].settlements[0].receivedAt = -1;
  const unsupportedMethod = validResponse();
  unsupportedMethod.bills[0].settlements[0].method = 'manual';
  for (const response of [badSettlement, unsupportedMethod]) {
    const { dependencies } = setup(response);
    await expect(getResidentBillingV2Statement(session, '2026-08', dependencies)).rejects.toThrow(
      RESIDENT_BILLING_STATEMENT_ERROR,
    );
  }
});

it('accepts null or absent settlement reference without inventing a value', async () => {
  for (const reference of [null, undefined]) {
    const response = validResponse();
    const settlement: Record<string, unknown> = response.bills[0].settlements[0];
    if (reference === undefined) Reflect.deleteProperty(settlement, 'reference');
    else settlement.reference = reference;
    const { dependencies } = setup(response);
    const result = await getResidentBillingV2Statement(session, '2026-08', dependencies);
    expect(result.bills[0].settlements[0].reference).toBeNull();
  }
});

it.each([
  ['billed total', (data: ReturnType<typeof validResponse>) => (data.summary.billedMinor = 9999)],
  [
    'charge line total',
    (data: ReturnType<typeof validResponse>) => (data.bills[0].chargeLines[0].amountMinor = 9999),
  ],
  [
    'settlement total',
    (data: ReturnType<typeof validResponse>) =>
      (data.bills[0].settlements[0].netAppliedMinor = 2999),
  ],
  [
    'status count',
    (data: ReturnType<typeof validResponse>) => (data.summary.statusCounts.paid = 1),
  ],
])('rejects inconsistent %s', async (_label, mutate) => {
  const response = validResponse();
  mutate(response);
  const { dependencies } = setup(response);
  await expect(getResidentBillingV2Statement(session, '2026-08', dependencies)).rejects.toThrow(
    RESIDENT_BILLING_STATEMENT_ERROR,
  );
});

it('surfaces one safe error for callable failures', async () => {
  const { dependencies } = setup(undefined, {
    invokeCall: vi.fn(async () => {
      throw new Error('private backend error text');
    }),
  });
  await expect(getResidentBillingV2Statement(session, '2026-08', dependencies)).rejects.toThrow(
    RESIDENT_BILLING_STATEMENT_ERROR,
  );
});

it('contains no direct client reads of canonical financial ledger collections', () => {
  const source = readFileSync('src/residentBillingStatement.ts', 'utf8');
  expect(source).not.toMatch(
    /paymentTransactions|paymentAllocations|residentCreditEntries|residentFinancialAccounts/,
  );
});
