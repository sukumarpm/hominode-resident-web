import { dateOf, type Data } from './models';

export const petVisitMessage =
  'Pets are not permitted for this visit. You may continue without a pet.';
export const visitorWindowMs = 24 * 60 * 60 * 1000;
const approvedStates = new Set(['auto_authorized', 'admin_authorized']);
export function visitorAuthorization(data: Data): string {
  switch (data.authorizationState) {
    case 'auto_authorized':
      return 'Resident authorized';
    case 'admin_authorized':
      return 'Admin authorized';
    case 'pending_admin':
      return 'Pending Admin approval';
    case 'rejected':
      return 'Rejected';
    case 'revoked':
      return 'Revoked';
  }
  if (data.authorizationManaged === true) return 'Authorization unavailable';
  if ((data.visitorPolicySnapshot as Data | undefined)?.enforced === false)
    return 'Resident authorized';
  return 'Legacy invitation — authorization checked when opening the pass';
}
export function visitorPhysicalState(data: Data, now = Date.now()): string {
  const raw = String(data.status || '').toLowerCase();
  if (
    data.departure != null ||
    data.checkOutTime != null ||
    ['completed', 'departed', 'checked_out', 'checked-out', 'exited'].includes(raw)
  )
    return 'Checked out';
  if (
    data.gateAccessStatus === 'denied' ||
    data.gateEntryDeniedAt != null ||
    ['denied', 'entry_denied'].includes(raw)
  )
    return 'Entry denied';
  if (['cancelled', 'canceled'].includes(raw)) return 'Cancelled';
  if (
    data.actualArrival != null ||
    data.checkInTime != null ||
    ['inside', 'arrived', 'checked_in', 'active'].includes(raw)
  )
    return 'Checked in';
  if (['rejected', 'revoked'].includes(String(data.authorizationState)) || raw === 'rejected')
    return 'Not checked in';
  const arrival = dateOf(data.expectedArrival ?? data.expectedTime)?.getTime();
  if (arrival == null || now > arrival + visitorWindowMs) return 'Expired';
  return ['expected', 'pending', 'approved'].includes(raw) ? 'Expected' : 'Unknown';
}
export function canRequestVisitorPass(data: Data, now = Date.now()): boolean {
  if (visitorPhysicalState(data, now) !== 'Expected') return false;
  if (data.authorizationState != null && !approvedStates.has(String(data.authorizationState)))
    return false;
  if (data.authorizationManaged === true && data.authorizationState == null) return false;
  const arrival = dateOf(data.expectedArrival ?? data.expectedTime)?.getTime();
  return arrival != null && Math.abs(now - arrival) <= visitorWindowMs;
}
export function visitorPassMessage(data: Data, now = Date.now()) {
  const physical = visitorPhysicalState(data, now);
  if (physical !== 'Expected')
    return `This visitor pass is unavailable: ${physical.toLowerCase()}.`;
  if (data.authorizationState === 'pending_admin')
    return 'Waiting for your Community Admin. The pass will be available after authorization.';
  if (data.authorizationManaged === true && !approvedStates.has(String(data.authorizationState)))
    return 'This invitation is not authorized. Reload or contact your Community Admin.';
  return 'The pass is available within 24 hours before and after the expected arrival. Authorization is checked by the server.';
}
export function canChangeVisitor(data: Data) {
  const raw = String(data.status || '').toLowerCase();
  return (
    ['expected', 'pending', 'approved'].includes(raw) &&
    data.actualArrival == null &&
    data.checkInTime == null &&
    data.departure == null &&
    data.checkOutTime == null &&
    data.gateAccessStatus !== 'denied' &&
    data.gateEntryDeniedAt == null &&
    !['rejected', 'revoked'].includes(String(data.authorizationState))
  );
}
export function residentVisitorError(error: unknown) {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code).split('/').at(-1)
      : '';
  const message = error instanceof Error ? error.message : '';
  if (message.includes('Pets are not permitted')) return petVisitMessage;
  if (code === 'aborted')
    return 'This invitation changed. Reload and review its current status before trying again.';
  if (code === 'permission-denied' || code === 'unauthenticated')
    return 'Visitor access denied. Sign in again or contact your Community Admin.';
  if (code === 'not-found')
    return 'This visitor service or invitation is unavailable. Reload or contact support.';
  if (code === 'unavailable' || code === 'deadline-exceeded')
    return 'The result could not be confirmed. Check your visitor list before retrying.';
  return message || 'The request could not be completed. Reload and try again.';
}

function wall(ms: number, zone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function visitorLocalTime(ms: number, zone?: string) {
  return wall(ms, communityZone(zone));
}
export function visitorArrival(value: string, zone?: string) {
  zone = communityZone(zone);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value))
    throw Error('Enter a complete arrival date and time.');
  const naive = Date.parse(value + ':00Z');
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 16) !== value)
    throw Error('Choose a valid arrival time.');
  const offsets = new Set<number>();
  for (let h = -48; h <= 48; h += 6) {
    const sample = naive + h * 3600000;
    offsets.add(Date.parse(wall(sample, zone) + ':00Z') - sample);
  }
  const matches = [...offsets]
    .map((offset) => naive - offset)
    .filter((ms) => wall(ms, zone) === value);
  if (matches.length !== 1)
    throw Error(
      'This community-local time is skipped or repeated by daylight saving. Choose an unambiguous time.',
    );
  return matches[0];
}

export function communityZone(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw Error('Community timezone is not configured. Contact your Community Admin.');
  const zone = value.trim() === 'Asia/Calcutta' ? 'Asia/Kolkata' : value.trim();
  try {
    if (/^[+-]/.test(zone)) throw Error();
    new Intl.DateTimeFormat('en', { timeZone: zone }).format(0);
  } catch { throw Error(`Unsupported community timezone: ${value}. Contact your Community Admin.`); }
  return zone;
}
export function communityTimeLabel(value: unknown, at = Date.now()): string {
  try {
    const zone = communityZone(value);
    const abbreviation = new Intl.DateTimeFormat('en-IN', {timeZone: zone, timeZoneName: 'short'})
      .formatToParts(at).find(p => p.type === 'timeZoneName')?.value;
    return `Community time · ${zone} (${abbreviation})`;
  } catch (error) { return (error as Error).message; }
}
export function communityDate(value: unknown, zoneValue: unknown): string {
  const date = dateOf(value);
  if (!date) return '—';
  try {
    const zone = communityZone(zoneValue);
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: zone, year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
    }).format(date) + ` (${zone})`;
  } catch (error) { return (error as Error).message; }
}
