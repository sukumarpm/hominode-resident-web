import {
  collection,
  doc,
  documentId,
  onSnapshot,
  query,
  where,
  type QueryConstraint,
} from 'firebase/firestore';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { call, firebase } from './firebase';
import { dateOf, str, type Data, type Row, type Session } from './models';
import { assertScope } from './policy';
import type { PhotoScope } from './photoScope';
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
  announcementFeed?: 'resident';
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
    events: 'events_announcements',
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
  if (m === 'events') filters.push(['type', '==', 'event']);
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
    if (m === 'notices') return { collection: 'notices', filters, announcementFeed: 'resident' };
  }
  return { collection: names[m], filters };
}

/** Merge legacy Notice Board rows with canonical announcements without rewriting stored data. */
export function mergeAnnouncementRows(rows: Row[]): Row[] {
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const data = row.data;
      const title = str(data.title).toLocaleLowerCase().replace(/\s+/g, ' ');
      const content = str(data.content ?? data.description)
        .toLocaleLowerCase()
        .replace(/\s+/g, ' ');
      const time =
        dateOf(data.publishedAt ?? data.publishDate ?? data.createdAt)
          ?.toISOString()
          .slice(0, 10) ?? '';
      const signature = `${title}\u0000${content}\u0000${time}`;
      if (!title || !content || seen.has(signature)) return false;
      seen.add(signature);
      return true;
    })
    .sort(
      (a, b) =>
        (dateOf(b.data.publishedAt ?? b.data.publishDate ?? b.data.createdAt)?.getTime() || 0) -
        (dateOf(a.data.publishedAt ?? a.data.publishDate ?? a.data.createdAt)?.getTime() || 0),
    );
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
          error(Error('Payment history could not be validated.'));
          return;
        }
        emit({ rows: validated as Row[], loading: false, error: '' });
        return;
      }

      const safe = rows.filter((row) =>
        spec.filters.every(([field, op, value]) =>
          op === '=='
            ? row.data[field] === value
            : Array.isArray(row.data[field]) && (row.data[field] as unknown[]).includes(value),
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
    const announcementError = (e: unknown) => {
      if (!active || failed) return;
      error(e);
      stop();
    };
    if (spec.announcementFeed) {
      const [, uid, communityId, flatId] = JSON.parse(key) as string[];
      const canonical = new Map<string, Row>();
      const oldAnnouncements = new Map<string, Row>();
      const legacy = new Map<string, Row>();
      let canonicalReady = false;
      let oldAnnouncementsReady = false;
      let legacyReady = false;
      const publish = () => {
        if (failed || !canonicalReady || !oldAnnouncementsReady || !legacyReady) return;
        const visibleCanonical = [...canonical.values()].filter(
          (row) => row.data.status === 'active' || row.data.status === 'published',
        );
        emit({
          rows: mergeAnnouncementRows([
            ...visibleCanonical,
            ...oldAnnouncements.values(),
            ...legacy.values(),
          ]),
          loading: false,
          error: '',
        });
      };
      const stops: (() => void)[] = [];
      stops.push(
        onSnapshot(
          query(
            collection(firebase().db, 'events_announcements'),
            where('communityId', '==', communityId),
            where('type', '==', 'announcement'),
          ),
          (snap) => {
            canonical.clear();
            snap.docs.forEach((d) =>
              canonical.set(d.id, {
                id: d.id,
                data: { ...d.data(), _sourceCollection: 'events_announcements' },
              }),
            );
            canonicalReady = true;
            publish();
          },
          announcementError,
        ),
      );
      stops.push(
        onSnapshot(
          query(
            collection(firebase().db, 'announcements'),
            where('communityId', '==', communityId),
          ),
          (snap) => {
            oldAnnouncements.clear();
            snap.docs.forEach((d) =>
              oldAnnouncements.set(d.id, {
                id: d.id,
                data: { ...d.data(), _sourceCollection: 'announcements' },
              }),
            );
            oldAnnouncementsReady = true;
            publish();
          },
          announcementError,
        ),
      );

      const loadLegacy = (ids: string[]) => {
        if (!active || failed) return;
        if (!ids.length) {
          legacyReady = true;
          publish();
          return;
        }
        const pending = new Set(ids);
        ids.forEach((id) =>
          stops.push(
            onSnapshot(
              doc(firebase().db, 'notices', id),
              (snap) => {
                pending.delete(id);
                if (snap.exists())
                  legacy.set(id, {
                    id,
                    data: { ...snap.data(), _sourceCollection: 'notices' },
                  });
                else legacy.delete(id);
                if (!pending.size) {
                  legacyReady = true;
                  publish();
                }
              },
              announcementError,
            ),
          ),
        );
      };

      if (spec.announcementFeed === 'resident') {
        void call<{ communityId: string; flatId: string; noticeIds: string[] }>(
          'getResidentNoticeIds',
        )
          .then((result) => {
            if (!active || failed) return;
            if (
              result.communityId !== communityId ||
              result.flatId !== flatId ||
              !uid ||
              !Array.isArray(result.noticeIds)
            )
              throw Error('Notice access could not be verified.');
            loadLegacy(result.noticeIds);
          })
          .catch(() => announcementError(Error('Community announcements could not be verified.')));
      } else {
        stops.push(
          onSnapshot(
            query(collection(firebase().db, 'notices'), where('communityId', '==', communityId)),
            (snap) => {
              legacy.clear();
              snap.docs.forEach((d) =>
                legacy.set(d.id, {
                  id: d.id,
                  data: { ...d.data(), _sourceCollection: 'notices' },
                }),
              );
              legacyReady = true;
              publish();
            },
            announcementError,
          ),
        );
      }
      stop = () => stops.splice(0).forEach((unsubscribe) => unsubscribe());
    } else if (spec.notices) {
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

export function useResidentV2Payments(session: Session, enabled = true, revision = 0): Resource {
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

/** Existing community gallery contract; active records only, no client writes. */
export function useApartmentImages(
  session: Session,
  ownershipScope?: PhotoScope,
  resourceId?: string,
): Resource {
  const config = useMemo(() => {
    try {
      const communityId = assertScope(session);
      return {
        spec: {
          collection: ownershipScope ? 'apartmentImagesV2' : 'apartmentImages',
          filters: [
            ['communityId', '==', communityId],
            ['status', '==', 'active'],
            ...(ownershipScope
              ? [
                  ['contractVersion', '==', 2],
                  ['ownershipScope', '==', ownershipScope],
                  [
                    'resourceId',
                    '==',
                    resourceId || (ownershipScope === 'COMMUNITY' ? communityId : ''),
                  ],
                  ...(ownershipScope === 'UNIT'
                    ? [
                        ['unitId', '==', session.profile.flatId],
                        ['buildingId', '==', session.profile.buildingId],
                      ]
                    : []),
                  ...(ownershipScope === 'BUILDING'
                    ? [['buildingId', '==', resourceId || '']]
                    : []),
                ]
              : []),
          ] as Filter[],
        } as Spec,
        error: '',
      };
    } catch {
      return { spec: null, error: 'Photos are unavailable.' };
    }
  }, [session, ownershipScope, resourceId]);
  const key = JSON.stringify(['apartment-images', session.uid, session.community?.id, config.spec]);
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
