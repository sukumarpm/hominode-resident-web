import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  collection,
  doc,
  documentId,
  onSnapshot,
  query,
  where,
  type QueryConstraint,
} from 'firebase/firestore';
import { firebase, call } from './firebase';
import { assertScope } from './policy';
import { type Row, type Session, type Data, dateOf, str } from './models';
export type Module =
  | 'residents'
  | 'buildings'
  | 'units'
  | 'visitors'
  | 'complaints'
  | 'facilities'
  | 'bookings'
  | 'billing'
  | 'payments'
  | 'notices'
  | 'events'
  | 'documents'
  | 'community'
  | 'messages'
  | 'vehicles'
  | 'parking'
  | 'deliveries'
  | 'notifications'
  | 'sos'
  | 'communities'
  | 'admins';
export type Filter = [string, '==' | 'array-contains', unknown];
export interface Spec {
  collection: string;
  filters: Filter[];
  document?: string;
  notices?: boolean;
  residentV2Payments?: { communityId: string; residentId: string };
}
export function querySpec(s: Session, m: Module): Spec {
  if (s.role === 'superAdmin') {
    if (m === 'communities') return { collection: 'communities', filters: [] };
    if (m === 'admins') return { collection: 'admins', filters: [['role', '==', 'admin']] };
    throw Error('Platform accounts cannot read operational data.');
  }
  const communityId = assertScope(s);
  const filters: Filter[] = [['communityId', '==', communityId]];
  const names: Record<Module, string> = {
    residents: 'users',
    buildings: 'buildings',
    units: 'flats',
    visitors: 'visitors',
    complaints: 'complaints',
    facilities: 'amenities',
    bookings: 'bookings',
    billing: 'bills',
    payments: 'payments',
    notices: 'notices',
    events: 'events',
    documents: 'documents',
    community: 'posts',
    messages: 'chats',
    vehicles: 'vehicles',
    parking: 'parkingSlots',
    deliveries: 'parcels',
    notifications: 'notifications',
    sos: 'sosAlerts',
    communities: 'communities',
    admins: 'admins',
  };
  if (m === 'communities' || m === 'admins') throw Error('A platform administrator is required.');
  if (m === 'notifications')
    filters.push(
      ['recipientId', '==', s.uid],
      ['audience', '==', s.role],
      ['role', '==', s.role],
      ['appId', '==', s.role],
    );
  if (m === 'residents') filters.push(['role', '==', 'resident']);
  if (s.role === 'resident') {
    if (['residents', 'parking', 'deliveries'].includes(m))
      throw Error(
        'This workflow is not yet available on the web. Please use the mobile app or contact management.',
      );
    if (m === 'buildings')
      return { collection: 'buildings', filters, document: s.profile.buildingId };
    if (m === 'units') return { collection: 'flats', filters, document: s.profile.flatId };
    if (m === 'visitors') filters.push(['hostUserId', '==', s.uid]);
    if (m === 'complaints')
      filters.push(
        ['userId', '==', s.uid],
        ['residentId', '==', s.uid],
        ['flatId', '==', s.profile.flatId],
      );
    if (['billing', 'payments', 'vehicles'].includes(m))
      filters.push(['flatId', '==', s.profile.flatId]);
    if (['payments', 'bookings'].includes(m)) filters.push(['userId', '==', s.uid]);
    if (m === 'messages') filters.push(['participantIds', 'array-contains', s.uid]);
    if (m === 'community') filters.push(['buildingId', '==', s.profile.buildingId]);
    if (m === 'documents')
      filters.push(['buildingId', '==', s.profile.buildingId], ['status', '==', 'published']);
    if (m === 'sos') filters.push(['residentUid', '==', s.uid]);
    if (m === 'notices') return { collection: 'notices', filters, notices: true };
  }
  return { collection: names[m], filters };
}
export interface Resource {
  rows: Row[];
  loading: boolean;
  error: string;
}
const initial: Resource = { rows: [], loading: true, error: '' };
const emptyResource: Resource = { rows: [], loading: false, error: '' };
const maximumPaymentTimestampMs = 8_640_000_000_000_000;
const stores = new Map<string, { state: Resource; listeners: Set<() => void>; stop: () => void }>();
const message = (e: unknown) =>
  e instanceof Error ? e.message : 'Unable to load this information. Please try again.';

export function residentV2PaymentRow(
  id: string,
  data: Data,
  communityId: string,
  residentId: string,
): Row | null {
  const receivedAt = data.receivedAt;
  const createdAt = data.createdAt;
  const isValidTimestamp = (value: unknown) =>
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximumPaymentTimestampMs;

  if (
    !id ||
    data.schemaVersion !== 2 ||
    (data.id !== undefined && data.id !== id) ||
    (data.transactionId !== undefined && data.transactionId !== id) ||
    data.communityId !== communityId ||
    data.residentId !== residentId ||
    data.currency !== 'INR' ||
    typeof data.amountMinor !== 'number' ||
    !Number.isSafeInteger(data.amountMinor) ||
    data.amountMinor <= 0 ||
    typeof data.method !== 'string' ||
    !['upi', 'cash', 'bank_transfer', 'cheque'].includes(data.method) ||
    (receivedAt !== undefined && !isValidTimestamp(receivedAt)) ||
    (createdAt !== undefined && !isValidTimestamp(createdAt)) ||
    !isValidTimestamp(receivedAt !== undefined ? receivedAt : createdAt)
  )
    return null;

  const reference = data.reference;
  if (
    reference !== undefined &&
    reference !== null &&
    (typeof reference !== 'string' ||
      !reference ||
      reference !== reference.trim() ||
      reference.length > 200)
  )
    return null;

  const recordedAt = new Date((receivedAt !== undefined ? receivedAt : createdAt) as number);
  const normalized: Data = {
    transactionId: id,
    schemaVersion: 2,
    currency: 'INR',
    amountMinor: data.amountMinor,
    method: data.method,
    status: 'completed',
    recordedAt,
  };
  if (typeof reference === 'string') normalized.paymentReference = reference;
  return { id, data: normalized, source: 'residentBillingV2Payment' };
}

export function mergeResidentPaymentRows(legacyRows: Row[], v2Rows: Row[]): Row[] {
  const usedIds = new Set(legacyRows.map((row) => row.id));
  const mergedV2 = v2Rows.map((row) => {
    const baseId = `billing-v2-transaction:${row.id}`;
    let id = baseId;
    let suffix = 0;
    while (usedIds.has(id)) id = `${baseId}:${++suffix}`;
    usedIds.add(id);
    return { ...row, id };
  });
  return [...legacyRows, ...mergedV2].sort((a, b) => {
    const aTimestamp = dateOf(
      a.source === 'residentBillingV2Payment'
        ? a.data.recordedAt
        : (a.data.createdAt ?? a.data.triggeredAt),
    )?.getTime();
    const bTimestamp = dateOf(
      b.source === 'residentBillingV2Payment'
        ? b.data.recordedAt
        : (b.data.createdAt ?? b.data.triggeredAt),
    )?.getTime();
    return (bTimestamp || 0) - (aTimestamp || 0);
  });
}

export function combineResidentPaymentResources(legacy: Resource, v2: Resource): Resource {
  const error = legacy.error || v2.error;
  if (error) return { rows: [], loading: false, error };
  if (legacy.loading || v2.loading) return { rows: [], loading: true, error: '' };
  return { rows: mergeResidentPaymentRows(legacy.rows, v2.rows), loading: false, error: '' };
}

function subscribe(key: string, spec: Spec, notify: () => void) {
  let store = stores.get(key);
  if (!store) {
    store = { state: initial, listeners: new Set(), stop: () => {} };
    stores.set(key, store);
    const target = store;
    let active = true,
      failed = false;
    const emit = (state: Resource) => {
      if (!active) return;
      target.state = state;
      target.listeners.forEach((l) => l());
    };
    const error = (e: unknown) => {
      failed = true;
      emit({ rows: [], loading: false, error: message(e) });
    };
    const accept = (rows: Row[]) => {
      if (failed) return;
      if (spec.residentV2Payments) {
        const validated = rows.map((row) =>
          residentV2PaymentRow(
            row.id,
            row.data,
            spec.residentV2Payments!.communityId,
            spec.residentV2Payments!.residentId,
          ),
        );
        if (validated.some((row) => row === null)) {
          error(Error('Billing V2 payment history could not be validated.'));
          return;
        }
        emit({ rows: validated as Row[], loading: false, error: '' });
        return;
      }

      const safe = rows.filter((row) =>
            spec.filters.every(([field, op, value]) =>
              op === '=='
                ? row.data[field] === value
                : Array.isArray(row.data[field]) &&
                  (row.data[field] as unknown[]).includes(value),
            ),
          );
      safe.sort(
        (a, b) =>
          (dateOf(b.data.createdAt ?? b.data.triggeredAt)?.getTime() || 0) -
          (dateOf(a.data.createdAt ?? a.data.triggeredAt)?.getTime() || 0),
      );
      emit({ rows: safe, loading: false, error: '' });
    };
    let stop = () => {};
    if (spec.notices) {
      let stops: (() => void)[] = [];
      void call<{ communityId: string; flatId: string; noticeIds: string[] }>(
        'getResidentNoticeIds',
      )
        .then((result) => {
          if (!active) return;
          const [, uid, communityId, flatId] = JSON.parse(key) as string[];
          if (
            result.communityId !== communityId ||
            result.flatId !== flatId ||
            !Array.isArray(result.noticeIds) ||
            !uid
          )
            throw Error('Notice access could not be verified.');
          if (!result.noticeIds.length) {
            accept([]);
            return;
          }
          const found = new Map<string, Row>();
          const pending = new Set(result.noticeIds);
          stops = result.noticeIds.map((id) =>
            onSnapshot(
              doc(firebase().db, 'notices', id),
              (snap) => {
                pending.delete(id);
                if (snap.exists()) found.set(id, { id, data: snap.data() });
                else found.delete(id);
                if (!pending.size) accept([...found.values()]);
              },
              error,
            ),
          );
        })
        .catch(() =>
          error(
            Error(
              'Community announcements are not available on this web portal yet. Please use the Resident mobile app.',
            ),
          ),
        );
      stop = () => stops.forEach((s) => s());
    } else if (spec.document) {
      stop = onSnapshot(
        doc(firebase().db, spec.collection, spec.document),
        (snap) => accept(snap.exists() ? [{ id: snap.id, data: snap.data() }] : []),
        error,
      );
    } else {
      const constraints: QueryConstraint[] = spec.filters.map(([f, op, v]) =>
        where(f === '__name__' ? documentId() : f, op, v),
      );
      stop = onSnapshot(
        query(collection(firebase().db, spec.collection), ...constraints),
        (snap) => accept(snap.docs.map((d) => ({ id: d.id, data: d.data() }))),
        error,
      );
    }
    target.stop = () => {
      active = false;
      stop();
    };
  }
  store.listeners.add(notify);
  return () => {
    store.listeners.delete(notify);
    if (!store.listeners.size) {
      store.stop();
      stores.delete(key);
    }
  };
}
export function useRows(session: Session, module: Module, revision = 0): Resource {
  const config = useMemo(() => {
    try {
      return { spec: querySpec(session, module), error: '' };
    } catch (e) {
      return { spec: null, error: message(e) };
    }
  }, [session, module]);
  const key = JSON.stringify([
    module,
    session.uid,
    session.community?.id || '',
    session.profile.flatId,
    config.spec,
    revision,
  ]);
  const fallback = useMemo<Resource>(
    () => (config.error ? { rows: [], loading: false, error: config.error } : initial),
    [config.error],
  );
  const listen = useCallback(
    (notify: () => void) => (config.spec ? subscribe(key, config.spec, notify) : () => {}),
    [key, config.spec],
  );
  const snapshot = useCallback(() => stores.get(key)?.state || fallback, [key, fallback]);
  return useSyncExternalStore(listen, snapshot, snapshot);
}

export function useResidentV2Payments(
  session: Session,
  enabled = true,
  revision = 0,
): Resource {
  const config = useMemo(() => {
    if (!enabled || session.role !== 'resident') return { spec: null, error: '' };
    try {
      const communityId = assertScope(session);
      if (!session.uid.trim()) throw Error('Resident identity could not be verified.');
      return {
        spec: {
          collection: 'paymentTransactions',
          filters: [
            ['communityId', '==', communityId],
            ['residentId', '==', session.uid],
          ] as Filter[],
          residentV2Payments: { communityId, residentId: session.uid },
        },
        error: '',
      };
    } catch (e) {
      return { spec: null, error: message(e) };
    }
  }, [enabled, session]);
  const key = JSON.stringify([
    'resident-v2-payments',
    session.uid,
    session.community?.id || '',
    config.spec,
    revision,
  ]);
  const fallback = useMemo<Resource>(() => {
    if (config.error) return { rows: [], loading: false, error: config.error };
    return config.spec ? initial : emptyResource;
  }, [config.error, config.spec]);
  const listen = useCallback(
    (notify: () => void) => (config.spec ? subscribe(key, config.spec, notify) : () => {}),
    [key, config.spec],
  );
  const snapshot = useCallback(() => stores.get(key)?.state || fallback, [key, fallback]);
  return useSyncExternalStore(listen, snapshot, snapshot);
}
export function safeUrl(value: unknown): string | undefined {
  try {
    const u = new URL(str(value));
    return u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}
export function titleOf(d: Data) {
  return (
    [
      'title',
      'visitorName',
      'name',
      'fullName',
      'buildingName',
      'amenityName',
      'subject',
      'flatLabel',
      'unitLabel',
      'flatNumber',
    ]
      .map((k) => str(d[k]))
      .find(Boolean) || 'Details'
  );
}
