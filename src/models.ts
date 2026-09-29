export type Data = Record<string, unknown>;
export type Role = 'admin' | 'resident' | 'superAdmin';
export interface Community {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  ownerIdentityVerificationRequired: boolean;
  data: Data;
}
export interface Profile {
  uid: string;
  role: Role;
  name: string;
  phoneNumber: string;
  communityId: string;
  flatId: string;
  buildingId: string;
  flatLabel: string;
  authorizedCommunityIds: string[];
  data: Data;
}
export interface Session {
  uid: string;
  role: Role;
  profile: Profile;
  communities: Community[];
  community: Community | null;
}
export interface Row {
  id: string;
  data: Data;
}
export interface VisitorDocument {
  communityId: string;
  hostUserId: string;
  flatId: string;
  visitorName: string;
  purpose: string;
  status: string;
  isApproved: boolean;
}
export interface ComplaintDocument {
  communityId: string;
  userId: string;
  residentId: string;
  flatId: string;
  title: string;
  description: string;
  category: string;
  status: 'pending' | 'inprogress' | 'completed';
}
export interface BillDocument {
  communityId: string;
  flatId: string;
  amount: number;
  status: string;
}
export interface DirectUpiPaymentPreparation {
  billId: string;
  amount: number;
  vpa: string;
  payeeName: string;
  paymentUri: string;
  schemaVersion?: 2;
  amountMinor?: number;
  outstandingAmountMinor?: number;
  currentRevisionId?: string;
}
export interface SosDocument {
  communityId: string;
  residentUid: string;
  status: 'triggered' | 'acknowledged' | 'responding' | 'resolved' | 'cancelled';
}
export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
export function paymentMethodLabel(value: unknown): string {
  const method = str(value).toLowerCase();
  const labels: Record<string, string> = {
    upi: 'UPI',
    cash: 'Cash',
    bank_transfer: 'Bank Transfer',
    cheque: 'Cheque',
    manual: 'Manual',
    external: 'External',
  };
  if (labels[method]) return labels[method];
  return method
    ? method.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
    : '—';
}
export function paymentAttributionLabel(value: unknown): string {
  const method = str(value).toLowerCase();
  if (method === 'upi') return 'Verified by Admin';
  if (['cash', 'bank_transfer', 'cheque', 'manual'].includes(method)) return 'Recorded by Admin';
  return '';
}
export const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? [
        ...new Set(
          v
            .filter((x): x is string => typeof x === 'string')
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      ]
    : [];
export const first = (d: Data, keys: string[], fallback = '') =>
  keys.map((k) => str(d[k])).find(Boolean) || fallback;
export function dateOf(value: unknown): Date | null {
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function')
    return value.toDate() as Date;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}
export const dateLabel = (value: unknown) =>
  dateOf(value)?.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) || '—';
export const money = (value: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(value);
export function amount(d: Data): number {
  for (const k of ['amount', 'totalAmount', 'billAmount', 'total', 'dueAmount']) {
    const v = d[k];
    const n =
      typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replaceAll(',', '')) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return 0;
}
export function isV2Bill(d: Data): boolean {
  return d.schemaVersion === 2;
}
export function isValidV2InrBill(d: Data): boolean {
  return (
    isV2Bill(d) &&
    d.currency === 'INR' &&
    ['amountMinor', 'paidAmountMinor', 'creditAppliedMinor', 'outstandingAmountMinor'].every(
      (key) => Number.isSafeInteger(d[key]) && (d[key] as number) >= 0,
    ) &&
    typeof d.currentRevisionId === 'string' &&
    !!d.currentRevisionId.trim()
  );
}
export function formatInrMinorUnits(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return '—';
  const digits = String(value);
  const whole = digits.length > 2 ? digits.slice(0, -2) : '0';
  const paise = digits.slice(-2).padStart(2, '0');
  const groupedWhole =
    whole.length > 3
      ? `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}`
      : whole;
  return `₹${groupedWhole}.${paise}`;
}
export function billingAmountLabel(d: Data): string {
  if (!isV2Bill(d)) return money(amount(d));
  if (d.currency !== 'INR' || !Number.isSafeInteger(d.amountMinor) || (d.amountMinor as number) < 0)
    return 'Unavailable';
  return formatInrMinorUnits(d.amountMinor);
}
export function status(d: Data): string {
  const raw = first(
    d,
    ['status', 'visitStatus', 'approvalStatus', 'paymentStatus'],
    d.isActive === true ? 'active' : d.isActive === false ? 'inactive' : '',
  )
    .toLowerCase()
    .replace(/[ _-]/g, '');
  if ('visitorName' in d || 'hostUserId' in d) {
    if (['rejected', 'cancelled'].includes(raw)) return raw;
    if (d.departure != null) return 'departed';
    if (d.actualArrival != null && d.isApproved === true) return 'inside';
    if (d.isApproved === true) return 'approved';
  }
  return raw;
}
