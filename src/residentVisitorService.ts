import { communityZone } from './residentVisitor';
import { call, firebase } from './firebase';
import { doc, onSnapshot } from 'firebase/firestore';
import { currentAuthority } from './actions';
import type { Row, Session } from './models';

export interface VisitorContext {
  communityId: string;
  authorizationState: string;
  petPermitted: boolean;
  policyRevision: number;
  serverTime: number;
}
export interface InvitationResult {
  visitorId: string;
  authorizationState?: string;
  authorizationRevision?: number;
  credentialsAvailable?: boolean;
}
export function ownVisitor(session: Session, data: Row['data']) {
  return (
    session.role === 'resident' &&
    data.communityId === session.community?.id &&
    data.hostUserId === session.uid &&
    (data.residentId == null || data.residentId === session.uid)
  );
}
export async function visitorContext(
  session: Session,
  expectedArrival: number,
): Promise<VisitorContext> {
  const fresh = await currentAuthority(session);
  if (fresh.role !== 'resident') throw Error('A Resident account is required.');
  const result = await call<VisitorContext>('getResidentVisitorContext', { expectedArrival });
  if (result.communityId !== fresh.community.id || typeof result.petPermitted !== 'boolean')
    throw Error('Visitor guidance is unavailable for your community.');
  return result;
}
export async function mutateResidentVisitor(
  session: Session,
  row: Row,
  action: 'cancel' | 'reschedule',
  changes?: { expectedArrival?: number; bringingPet?: boolean },
) {
  const fresh = await currentAuthority(session);
  if (action === 'reschedule' && changes?.expectedArrival !== undefined && communityZone(fresh.community.data.timeZone) !== communityZone(session.community?.data.timeZone))
    throw Error('Your community timezone changed. Reload the invitation form.');
  if (!ownVisitor(fresh, row.data))
    throw Error('This invitation is outside your Resident account or community.');
  const result = await call<{
    visitorId: string;
    authorizationState: string;
    authorizationRevision: number;
  }>('mutateResidentVisitor', {
    visitorId: row.id,
    action,
    expectedRevision: row.data.authorizationRevision ?? 0,
    ...(action === 'reschedule' ? changes : {}),
  });
  if (
    result?.visitorId !== row.id ||
    typeof result.authorizationRevision !== 'number' ||
    typeof result.authorizationState !== 'string'
  )
    throw Error('The change could not be confirmed. Reload your visitor list before retrying.');
  return result;
}
export function watchResidentVisitorCommunity(
  session: Session,
  changed: () => void,
  error: (error: Error) => void,
) {
  if (session.role !== 'resident' || session.profile.communityId !== session.community?.id)
    throw Error('Visitor community access denied.');
  const policyKey = (data: Record<string, unknown> | undefined) => JSON.stringify([
    data?.visitorPolicy ?? null, data?.scheduledVisitorPolicy ?? null,
  ]);
  let previous = policyKey(session.community.data);
  return onSnapshot(
    doc(firebase().db, 'communities', session.community.id),
    (snapshot) => {
      const next = policyKey(snapshot.data());
      if (previous !== next) changed();
      previous = next;
    },
    error,
  );
}
