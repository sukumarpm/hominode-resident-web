import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import { dateOf, type Data, type Session } from '../models';
import { call } from '../firebase';
import {
  canRequestVisitorPass,
  residentVisitorError,
  visitorPassMessage,
  visitorWindowMs,
} from '../residentVisitor';
import { ownVisitor, watchResidentVisitorCommunity } from '../residentVisitorService';
import '../residentVisitor.css';

export function visitorQrPayload(
  visitorId: string,
  data: Data,
  nowMs = Date.now(),
  credentials?: Data,
): string | null {
  if (!visitorId.trim() || !canRequestVisitorPass(data, nowMs) || credentials?.legacy === true)
    return null;
  const token = credentials?.qrToken;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return JSON.stringify({ type: 'hominode_visitor', version: 1, token });
}
export function VisitorQrPass({
  visitorId,
  data,
  session,
  loadCredentials = privateCredentials,
  watchCommunity = watchResidentVisitorCommunity,
}: {
  visitorId: string;
  data: Data;
  session?: Session;
  loadCredentials?: (id: string) => Promise<Data>;
  watchCommunity?: typeof watchResidentVisitorCommunity;
}) {
  const [privatePass, setPrivatePass] = useState<{ key: string; credentials: Data } | null>(null);
  const [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0),
    [now, setNow] = useState(Date.now());
  const fingerprint = JSON.stringify([
    visitorId,
    data.communityId,
    data.hostUserId,
    data.authorizationState,
    data.authorizationManaged,
    data.authorizationRevision,
    data.status,
    data.isApproved,
    dateOf(data.expectedArrival ?? data.expectedTime)?.getTime(),
    dateOf(data.updatedAt)?.getTime(),
    data.gateAccessStatus,
    dateOf(data.gateEntryDeniedAt)?.getTime(),
    dateOf(data.actualArrival)?.getTime(),
    dateOf(data.checkInTime)?.getTime(),
    dateOf(data.departure)?.getTime(),
    dateOf(data.checkOutTime)?.getTime(),
    session?.uid,
    session?.community?.data.visitorPolicy,
    session?.community?.data.scheduledVisitorPolicy,
  ]);
  const key = `${fingerprint}:${refresh}`;
  const ownsInvitation = !session || ownVisitor(session, data);
  const allowed = ownsInvitation && canRequestVisitorPass(data, now);
  const arrivalMs = dateOf(data.expectedArrival ?? data.expectedTime)?.getTime();
  useEffect(() => {
    let active = true;
    const requestedAt = performance.now();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const revalidate = (timing: Data | undefined) => {
      if (!active || !Number.isSafeInteger(timing?.serverTime) ||
        !Number.isSafeInteger(timing?.revalidateAt)) return true;
      // Deadlines use server time, independent of the device's wall clock.
      // Include the request duration conservatively so a delayed response
      // cannot extend a pass past a policy activation boundary.
      const delay = Number(timing!.revalidateAt) - Number(timing!.serverTime) -
        Math.max(0, performance.now() - requestedAt);
      deadline = setTimeout(() => {
        setPrivatePass(null);
        setNow(Date.now());
        setRefresh(v => v + 1);
      }, Math.max(0, Math.min(delay, 2147483647)));
      return delay > 0;
    };
    setPrivatePass(null);
    setError('');
    if (!allowed) return;
    void loadCredentials(visitorId)
      .then((value) => {
        if (!active) return;
        if (!revalidate(value)) return;
        const code = value.visitorPassCode;
        const normalized =
          typeof code === 'string' ? code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
        if (
          value.legacy === true ||
          typeof value.qrToken !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(value.qrToken) ||
          !/^[A-Z0-9]{8,32}$/.test(normalized)
        )
          throw Error('This visitor pass must be replaced. Contact your Community Admin.');
        if (active)
          setPrivatePass({ key, credentials: { qrToken: value.qrToken, visitorPassCode: code } });
      })
      .catch((e) => {
        if (active) {
          revalidate(e?.details);
          setError(residentVisitorError(e));
        }
      });
    return () => {
      active = false;
      clearTimeout(deadline);
    };
  }, [key, allowed, visitorId, loadCredentials]);
  useEffect(() => {
    const update = () => {
      setNow(Date.now());
      setRefresh((v) => v + 1);
    };
    const next =
      arrivalMs == null
        ? null
        : now < arrivalMs - visitorWindowMs
          ? arrivalMs - visitorWindowMs
          : arrivalMs + visitorWindowMs + 1;
    const timer =
      next != null && next > now ? setTimeout(update, Math.min(next - now, 2147483647)) : null;
    window.addEventListener('focus', update);
    const visible = () => { if (document.visibilityState === 'visible') update(); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [arrivalMs, now]);
  useEffect(() => {
    if (!session || !ownsInvitation) return;
    try {
      return watchCommunity(
        session,
        () => {
          setPrivatePass(null);
          setRefresh((v) => v + 1);
        },
        () => {
          setPrivatePass(null);
          setError('Visitor access could not be refreshed. Reload the pass.');
        },
      );
    } catch {
      setPrivatePass(null);
      setError('Visitor access could not be refreshed. Reload the pass.');
    }
  }, [session, ownsInvitation, watchCommunity]);
  const credentials = privatePass?.key === key ? privatePass.credentials : null;
  const payload =
    credentials && allowed ? visitorQrPayload(visitorId, data, now, credentials) : null;
  return (
    <section aria-labelledby="visitor-gate-qr-title" className="visitor-qr-pass">
      <h3 id="visitor-gate-qr-title">Visitor gate pass</h3>
      {!allowed ? (
        <p role="status">{visitorPassMessage(data, now)}</p>
      ) : error ? (
        <p role="status">{error}</p>
      ) : !payload ? (
        <p role="status">Loading private visitor pass…</p>
      ) : (
        <>
          <QRCodeSVG
            value={payload}
            size={220}
            level="M"
            includeMargin
            aria-label="Visitor gate QR code"
          />
          <p>
            Show this QR or manual code to Security. The gate verifies current authorization before
            check-in.
          </p>
          <p>
            Manual pass code: <strong>{String(credentials!.visitorPassCode)}</strong>
          </p>
        </>
      )}
      <button
        type="button"
        onClick={() => {
          setPrivatePass(null);
          setNow(Date.now());
          setRefresh((v) => v + 1);
        }}
      >
        Reload pass
      </button>
    </section>
  );
}
async function privateCredentials(visitorId: string): Promise<Data> {
  return call<Data>('getVisitorCredentials', { visitorId });
}
