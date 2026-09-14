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
export interface SosDocument {
  communityId: string;
  residentUid: string;
  status: 'triggered' | 'acknowledged' | 'responding' | 'resolved' | 'cancelled';
}
export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
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
