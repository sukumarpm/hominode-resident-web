import { currentAuthority } from './actions';
import { call } from './firebase';
import { type Session } from './models';

export const RESIDENT_BILLING_STATEMENT_CALLABLE = 'getResidentBillingV2Statement';
export const RESIDENT_BILLING_STATEMENT_ERROR =
  'Could not load the monthly statement. Please try again.';

export type ResidentStatementStatus = 'pending' | 'partially_paid' | 'paid' | 'overdue';
export type ResidentStatementMethod = 'upi' | 'cash' | 'bank_transfer' | 'cheque';

export interface ResidentBillingStatement {
  success: true;
  schemaVersion: 1;
  communityId: string;
  residentId: string;
  billingPeriod: string;
  generatedAtMs: number;
  summary: ResidentBillingStatementSummary;
  bills: ResidentBillingStatementBill[];
}

export interface ResidentBillingStatementSummary {
  billsCount: number;
  billedMinor: number;
  paidAllocationMinor: number;
  creditAppliedMinor: number;
  outstandingMinor: number;
  availableCreditMinor: number;
  statusCounts: Record<ResidentStatementStatus, number>;
}

export interface ResidentBillingStatementBill {
  billId: string;
  billingPeriod: string;
  amountMinor: number;
  paidAllocationMinor: number;
  creditAppliedMinor: number;
  outstandingMinor: number;
  status: ResidentStatementStatus;
  dueDateKey: string;
  chargeLines: ResidentStatementChargeLine[];
  settlements: ResidentStatementSettlement[];
}

export interface ResidentStatementChargeLine {
  lineId: string;
  code: string;
  label: string;
  amountMinor: number;
}

export interface ResidentStatementSettlement {
  transactionId: string;
  method: ResidentStatementMethod;
  reference: string | null;
  receivedAt: number;
  netAppliedMinor: number;
}

export interface ResidentBillingStatementDependencies {
  resolveAuthority?: (session: Session) => Promise<Session>;
  invokeCall?: (name: string, payload: Record<string, unknown>) => Promise<unknown>;
}

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const STATUSES = ['pending', 'partially_paid', 'paid', 'overdue'] as const;
const METHODS = ['upi', 'cash', 'bank_transfer', 'cheque'] as const;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

class InvalidStatementResponse extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new InvalidStatementResponse();
  }
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim())
    throw new InvalidStatementResponse();
  return value;
}

function validTrustedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new InvalidStatementResponse();
  return value;
}

function periodString(value: unknown): string {
  if (typeof value !== 'string' || !PERIOD.test(value)) throw new InvalidStatementResponse();
  return value;
}

function dueDateString(value: unknown): string {
  const date = nonEmptyString(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new InvalidStatementResponse();
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new InvalidStatementResponse();
  }
  return date;
}

function safeSum(values: readonly number[]): number {
  const sum = values.reduce((total, value) => total + BigInt(value), 0n);
  if (sum > MAX_SAFE_BIGINT) throw new InvalidStatementResponse();
  return Number(sum);
}

function parseChargeLine(value: unknown): ResidentStatementChargeLine {
  if (!record(value)) throw new InvalidStatementResponse();
  exactKeys(value, ['lineId', 'code', 'label', 'amountMinor']);
  return {
    lineId: nonEmptyString(value.lineId),
    code: nonEmptyString(value.code),
    label: nonEmptyString(value.label),
    amountMinor: nonNegativeInteger(value.amountMinor),
  };
}

function parseSettlement(value: unknown): ResidentStatementSettlement {
  if (!record(value)) throw new InvalidStatementResponse();
  exactKeys(value, ['transactionId', 'method', 'receivedAt', 'netAppliedMinor'], ['reference']);
  if (
    typeof value.method !== 'string' ||
    !METHODS.includes(value.method as ResidentStatementMethod)
  )
    throw new InvalidStatementResponse();
  if (value.reference !== undefined && value.reference !== null) nonEmptyString(value.reference);
  const netAppliedMinor = nonNegativeInteger(value.netAppliedMinor);
  if (netAppliedMinor === 0) throw new InvalidStatementResponse();
  return {
    transactionId: nonEmptyString(value.transactionId),
    method: value.method as ResidentStatementMethod,
    reference: typeof value.reference === 'string' ? value.reference : null,
    receivedAt: nonNegativeInteger(value.receivedAt),
    netAppliedMinor,
  };
}

function parseBill(value: unknown, requestedPeriod: string): ResidentBillingStatementBill {
  if (!record(value)) throw new InvalidStatementResponse();
  exactKeys(value, [
    'billId',
    'billingPeriod',
    'amountMinor',
    'paidAllocationMinor',
    'creditAppliedMinor',
    'outstandingMinor',
    'status',
    'dueDateKey',
    'chargeLines',
    'settlements',
  ]);
  const billingPeriod = periodString(value.billingPeriod);
  if (billingPeriod !== requestedPeriod) throw new InvalidStatementResponse();
  if (
    typeof value.status !== 'string' ||
    !STATUSES.includes(value.status as ResidentStatementStatus)
  )
    throw new InvalidStatementResponse();
  if (!Array.isArray(value.chargeLines) || !Array.isArray(value.settlements))
    throw new InvalidStatementResponse();

  const amountMinor = nonNegativeInteger(value.amountMinor);
  const paidAllocationMinor = nonNegativeInteger(value.paidAllocationMinor);
  const creditAppliedMinor = nonNegativeInteger(value.creditAppliedMinor);
  const outstandingMinor = nonNegativeInteger(value.outstandingMinor);
  if (
    BigInt(paidAllocationMinor) + BigInt(creditAppliedMinor) + BigInt(outstandingMinor) !==
    BigInt(amountMinor)
  ) {
    throw new InvalidStatementResponse();
  }
  const chargeLines = value.chargeLines.map(parseChargeLine);
  const settlements = value.settlements.map(parseSettlement);
  if (
    new Set(chargeLines.map((line) => line.lineId)).size !== chargeLines.length ||
    new Set(settlements.map((settlement) => settlement.transactionId)).size !==
      settlements.length ||
    safeSum(chargeLines.map((line) => line.amountMinor)) !== amountMinor ||
    safeSum(settlements.map((settlement) => settlement.netAppliedMinor)) !== paidAllocationMinor
  ) {
    throw new InvalidStatementResponse();
  }
  return {
    billId: nonEmptyString(value.billId),
    billingPeriod,
    amountMinor,
    paidAllocationMinor,
    creditAppliedMinor,
    outstandingMinor,
    status: value.status as ResidentStatementStatus,
    dueDateKey: dueDateString(value.dueDateKey),
    chargeLines,
    settlements,
  };
}

function parseStatement(
  value: unknown,
  session: Session,
  billingPeriod: string,
): ResidentBillingStatement {
  if (!record(value)) throw new InvalidStatementResponse();
  exactKeys(value, [
    'success',
    'schemaVersion',
    'communityId',
    'residentId',
    'billingPeriod',
    'generatedAtMs',
    'summary',
    'bills',
  ]);
  if (
    value.success !== true ||
    value.schemaVersion !== 1 ||
    value.communityId !== session.community!.id ||
    value.residentId !== session.uid ||
    value.billingPeriod !== billingPeriod
  ) {
    throw new InvalidStatementResponse();
  }
  const generatedAtMs = nonNegativeInteger(value.generatedAtMs);
  if (!record(value.summary) || !Array.isArray(value.bills)) throw new InvalidStatementResponse();
  const rawSummary = value.summary;
  exactKeys(rawSummary, [
    'billsCount',
    'billedMinor',
    'paidAllocationMinor',
    'creditAppliedMinor',
    'outstandingMinor',
    'availableCreditMinor',
    'statusCounts',
  ]);
  if (!record(rawSummary.statusCounts)) throw new InvalidStatementResponse();
  exactKeys(rawSummary.statusCounts, STATUSES);
  const summary: ResidentBillingStatementSummary = {
    billsCount: nonNegativeInteger(rawSummary.billsCount),
    billedMinor: nonNegativeInteger(rawSummary.billedMinor),
    paidAllocationMinor: nonNegativeInteger(rawSummary.paidAllocationMinor),
    creditAppliedMinor: nonNegativeInteger(rawSummary.creditAppliedMinor),
    outstandingMinor: nonNegativeInteger(rawSummary.outstandingMinor),
    availableCreditMinor: nonNegativeInteger(rawSummary.availableCreditMinor),
    statusCounts: {
      pending: nonNegativeInteger(rawSummary.statusCounts.pending),
      partially_paid: nonNegativeInteger(rawSummary.statusCounts.partially_paid),
      paid: nonNegativeInteger(rawSummary.statusCounts.paid),
      overdue: nonNegativeInteger(rawSummary.statusCounts.overdue),
    },
  };
  const bills = value.bills.map((bill) => parseBill(bill, billingPeriod));
  const counts: ResidentBillingStatementSummary['statusCounts'] = {
    pending: 0,
    partially_paid: 0,
    paid: 0,
    overdue: 0,
  };
  for (const bill of bills) counts[bill.status] += 1;
  if (
    bills.length !== summary.billsCount ||
    new Set(bills.map((bill) => bill.billId)).size !== bills.length ||
    safeSum(bills.map((bill) => bill.amountMinor)) !== summary.billedMinor ||
    safeSum(bills.map((bill) => bill.paidAllocationMinor)) !== summary.paidAllocationMinor ||
    safeSum(bills.map((bill) => bill.creditAppliedMinor)) !== summary.creditAppliedMinor ||
    safeSum(bills.map((bill) => bill.outstandingMinor)) !== summary.outstandingMinor ||
    STATUSES.some((status) => counts[status] !== summary.statusCounts[status])
  ) {
    throw new InvalidStatementResponse();
  }
  return {
    success: true,
    schemaVersion: 1,
    communityId: session.community!.id,
    residentId: session.uid,
    billingPeriod,
    generatedAtMs,
    summary,
    bills,
  };
}

export async function getResidentBillingV2Statement(
  session: Session,
  billingPeriod: string,
  dependencies: ResidentBillingStatementDependencies = {},
): Promise<ResidentBillingStatement> {
  const resolveAuthority = dependencies.resolveAuthority ?? currentAuthority;
  const invokeCall =
    dependencies.invokeCall ??
    ((name: string, payload: Record<string, unknown>) => call<unknown>(name, payload));
  const authority = await resolveAuthority(session);
  if (
    authority.role !== 'resident' ||
    authority.profile.role !== 'resident' ||
    !validTrustedId(authority.uid) ||
    !validTrustedId(authority.community?.id) ||
    authority.profile.uid !== authority.uid ||
    authority.uid !== session.uid ||
    !authority.community ||
    authority.community.isActive !== true ||
    authority.community.id !== session.community?.id ||
    authority.profile.communityId !== authority.community.id
  ) {
    throw new Error('Resident access could not be verified. Please sign in again.');
  }
  if (typeof billingPeriod !== 'string' || !PERIOD.test(billingPeriod))
    throw new Error('Choose a valid billing month.');

  try {
    const response = await invokeCall(RESIDENT_BILLING_STATEMENT_CALLABLE, { billingPeriod });
    return parseStatement(response, authority, billingPeriod);
  } catch {
    throw new Error(RESIDENT_BILLING_STATEMENT_ERROR);
  }
}
