import { currentAuthority } from './actions';
import { call } from './firebase';
import { type Session } from './models';

export const RESIDENT_BILLING_V2_RECEIPT_CALLABLE = 'getResidentBillingV2Receipt';
export const RESIDENT_BILLING_V2_RECEIPT_ERROR =
  'Could not load this verified receipt. Please try again.';

export interface ResidentBillingV2Receipt {
  receiptId: string;
  transactionId: string;
  communityName: string | null;
  communityAddress: string | null;
  method: 'upi' | 'cash' | 'bank_transfer' | 'cheque';
  paymentReference: string | null;
  receivedAt: number;
  moneyReceivedMinor: number;
  claimedAmountMinor: number | null;
  amountMismatch: boolean | null;
  verifiedAt: number;
  verifiedBy: string;
  allocations: Array<{ amountMinor: number; allocatedAt: number }>;
  allocatedAmountMinor: number;
  excessCreditMinor: number;
  reversedAllocationMinor: number;
  revisionCreditIssuedMinor: number;
}

export interface ResidentBillingV2ReceiptDependencies {
  resolveAuthority?: (session: Session) => Promise<Session>;
  invokeCall?: (name: string, payload: Record<string, unknown>) => Promise<unknown>;
}

const METHODS = ['upi', 'cash', 'bank_transfer', 'cheque'] as const;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

class InvalidReceiptResponse extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): void {
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key))
  ) {
    throw new InvalidReceiptResponse();
  }
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim())
    throw new InvalidReceiptResponse();
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  return nonEmptyString(value);
}

function safeInteger(value: unknown, allowZero = true): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new InvalidReceiptResponse();
  }
  return value;
}

function safeSum(values: readonly number[]): number {
  const sum = values.reduce((total, value) => total + BigInt(value), 0n);
  if (sum > MAX_SAFE_BIGINT) throw new InvalidReceiptResponse();
  return Number(sum);
}

function timestampMs(value: unknown): number {
  const timestamp = safeInteger(value);
  if (timestamp > 8640000000000000) throw new InvalidReceiptResponse();
  return timestamp;
}

function parseReceipt(
  value: unknown,
  transactionId: string,
  expectedCommunityId: string,
): ResidentBillingV2Receipt {
  if (!record(value)) throw new InvalidReceiptResponse();
  exactKeys(value, [
    'success',
    'schemaVersion',
    'receiptId',
    'transactionId',
    'community',
    'currency',
    'method',
    'paymentReference',
    'receivedAt',
    'moneyReceivedMinor',
    'confirmedAmountMinor',
    'claimedAmountMinor',
    'amountMismatch',
    'confirmation',
    'allocations',
    'allocatedAmountMinor',
    'excessCreditMinor',
    'reconciliation',
    'accountingBasis',
    'snapshot',
    'laterAdjustments',
  ]);
  if (
    value.success !== true ||
    value.schemaVersion !== 1 ||
    value.transactionId !== transactionId ||
    value.receiptId !== `HOMINODE-V2-${transactionId}` ||
    value.currency !== 'INR' ||
    typeof value.method !== 'string' ||
    !METHODS.includes(value.method as (typeof METHODS)[number])
  ) {
    throw new InvalidReceiptResponse();
  }

  if (!record(value.community)) throw new InvalidReceiptResponse();
  exactKeys(value.community, ['communityId', 'name', 'address']);
  if (nonEmptyString(value.community.communityId) !== expectedCommunityId)
    throw new InvalidReceiptResponse();
  const communityName = nullableText(value.community.name);
  const communityAddress = nullableText(value.community.address);

  const receivedAt = timestampMs(value.receivedAt);
  const moneyReceivedMinor = safeInteger(value.moneyReceivedMinor, false);
  const confirmedAmountMinor = safeInteger(value.confirmedAmountMinor, false);
  if (moneyReceivedMinor !== confirmedAmountMinor) throw new InvalidReceiptResponse();
  const claimedAmountMinor =
    value.claimedAmountMinor === null ? null : safeInteger(value.claimedAmountMinor, false);
  if (value.amountMismatch !== null && typeof value.amountMismatch !== 'boolean')
    throw new InvalidReceiptResponse();
  if (
    claimedAmountMinor !== null &&
    value.amountMismatch !== (claimedAmountMinor !== confirmedAmountMinor)
  ) {
    throw new InvalidReceiptResponse();
  }
  if (claimedAmountMinor === null && value.amountMismatch !== null)
    throw new InvalidReceiptResponse();

  if (!record(value.confirmation)) throw new InvalidReceiptResponse();
  exactKeys(value.confirmation, ['status', 'verifiedAt', 'verifiedBy']);
  if (value.confirmation.status !== 'verified') throw new InvalidReceiptResponse();
  const verifiedAt = timestampMs(value.confirmation.verifiedAt);
  const verifiedBy = nonEmptyString(value.confirmation.verifiedBy);

  if (!Array.isArray(value.allocations)) throw new InvalidReceiptResponse();
  const allocations = value.allocations.map((allocation) => {
    if (!record(allocation)) throw new InvalidReceiptResponse();
    exactKeys(allocation, ['billId', 'amountMinor', 'allocatedAt']);
    nonEmptyString(allocation.billId);
    return {
      amountMinor: safeInteger(allocation.amountMinor, false),
      allocatedAt: timestampMs(allocation.allocatedAt),
    };
  });
  const allocatedAmountMinor = safeInteger(value.allocatedAmountMinor);
  const excessCreditMinor = safeInteger(value.excessCreditMinor);
  if (safeSum(allocations.map((item) => item.amountMinor)) !== allocatedAmountMinor)
    throw new InvalidReceiptResponse();

  if (!record(value.reconciliation)) throw new InvalidReceiptResponse();
  exactKeys(value.reconciliation, [
    'confirmedAmountMinor',
    'allocatedAmountMinor',
    'excessCreditMinor',
  ]);
  if (
    safeInteger(value.reconciliation.confirmedAmountMinor, false) !== confirmedAmountMinor ||
    safeInteger(value.reconciliation.allocatedAmountMinor) !== allocatedAmountMinor ||
    safeInteger(value.reconciliation.excessCreditMinor) !== excessCreditMinor ||
    BigInt(allocatedAmountMinor) + BigInt(excessCreditMinor) !== BigInt(confirmedAmountMinor)
  ) {
    throw new InvalidReceiptResponse();
  }

  if (!record(value.accountingBasis)) throw new InvalidReceiptResponse();
  exactKeys(value.accountingBasis, [
    'amountsAreMinorUnits',
    'allocationsAreFromThisPayment',
    'existingCreditApplicationsExcluded',
  ]);
  if (
    value.accountingBasis.amountsAreMinorUnits !== true ||
    value.accountingBasis.allocationsAreFromThisPayment !== true ||
    value.accountingBasis.existingCreditApplicationsExcluded !== true ||
    value.snapshot !== 'original_settlement'
  ) {
    throw new InvalidReceiptResponse();
  }

  if (!record(value.laterAdjustments)) throw new InvalidReceiptResponse();
  exactKeys(value.laterAdjustments, ['reversedAllocationMinor', 'revisionCreditIssuedMinor']);

  return {
    receiptId: value.receiptId as string,
    transactionId,
    communityName,
    communityAddress,
    method: value.method as ResidentBillingV2Receipt['method'],
    paymentReference: nullableText(value.paymentReference),
    receivedAt,
    moneyReceivedMinor,
    claimedAmountMinor,
    amountMismatch: value.amountMismatch as boolean | null,
    verifiedAt,
    verifiedBy,
    allocations,
    allocatedAmountMinor,
    excessCreditMinor,
    reversedAllocationMinor: safeInteger(value.laterAdjustments.reversedAllocationMinor),
    revisionCreditIssuedMinor: safeInteger(value.laterAdjustments.revisionCreditIssuedMinor),
  };
}

export async function getResidentBillingV2Receipt(
  session: Session,
  transactionId: string,
  dependencies: ResidentBillingV2ReceiptDependencies = {},
): Promise<ResidentBillingV2Receipt> {
  const resolveAuthority = dependencies.resolveAuthority ?? currentAuthority;
  const invokeCall =
    dependencies.invokeCall ??
    ((name: string, payload: Record<string, unknown>) => call<unknown>(name, payload));

  try {
    const authority = await resolveAuthority(session);
    if (
      authority.role !== 'resident' ||
      authority.profile.role !== 'resident' ||
      authority.uid !== session.uid ||
      authority.profile.uid !== authority.uid ||
      !authority.community ||
      authority.community.isActive !== true ||
      authority.community.id !== session.community?.id ||
      authority.profile.communityId !== authority.community.id ||
      typeof transactionId !== 'string' ||
      !transactionId.trim() ||
      transactionId !== transactionId.trim()
    ) {
      throw new InvalidReceiptResponse();
    }
    const response = await invokeCall(RESIDENT_BILLING_V2_RECEIPT_CALLABLE, { transactionId });
    return parseReceipt(response, transactionId, authority.community.id);
  } catch {
    throw new Error(RESIDENT_BILLING_V2_RECEIPT_ERROR);
  }
}
