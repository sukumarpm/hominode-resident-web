export interface EventsEntitlement {
  communityId: string;
  resolvedRole?: string;
  status?: string;
  startsAtMs?: number | null;
  endsAtMs?: number | null;
  features?: Record<string, boolean>;
}

export function canResidentUseEvents(
  entitlement: EventsEntitlement | null,
  communityId: string,
  nowMs = Date.now(),
): boolean {
  if (
    !entitlement ||
    entitlement.communityId !== communityId ||
    entitlement.resolvedRole !== 'resident' ||
    entitlement.features?.events !== true
  ) return false;
  if (entitlement.startsAtMs != null && (!Number.isFinite(entitlement.startsAtMs) || nowMs < entitlement.startsAtMs)) return false;
  if (entitlement.endsAtMs != null && (!Number.isFinite(entitlement.endsAtMs) || nowMs >= entitlement.endsAtMs)) return false;
  if (entitlement.status === 'active') return true;
  return (entitlement.status === 'trial' || entitlement.status === 'grace') && entitlement.endsAtMs != null;
}
