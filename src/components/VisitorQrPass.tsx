import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import { dateOf, type Data } from '../models';
import { call } from '../firebase';

const visitorQrValidityMs = 24 * 60 * 60 * 1000;

export function visitorQrPayload(visitorId: string, data: Data, nowMs = Date.now()): string | null {
  const id = visitorId.trim();
  if (!id || data.actualArrival != null || data.departure != null) return null;

  const rawStatus = typeof data.status === 'string' ? data.status.trim().toLowerCase() : '';
  const pending = ['expected', 'pending'].includes(rawStatus) && data.isApproved === false;
  const approved = rawStatus === 'approved' && data.isApproved === true;
  if (!pending && !approved) return null;

  const expectedArrival = dateOf(data.expectedArrival ?? data.expectedTime);
  if (!expectedArrival || Math.abs(nowMs - expectedArrival.getTime()) > visitorQrValidityMs) {
    return null;
  }

  if (typeof data.qrToken === 'string') {
    const token = data.qrToken.trim();
    if (!token) return null;
    return JSON.stringify({ type: 'hominode_visitor', version: 1, token });
  }

  if (data.qrToken != null) return null;
  return JSON.stringify({ visitorId: id, legacy: true });
}

export function VisitorQrPass({ visitorId, data }: { visitorId: string; data: Data }) {
  const [credentials, setCredentials] = useState<Data | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    setCredentials(null);
    setUnavailable(false);
    void call<{ qrToken?: string | null; visitorPassCode?: string | null }>(
      'getVisitorCredentials',
      { visitorId },
    )
      .then((value) => {
        if (active) setCredentials(value);
      })
      .catch(() => {
        if (active) setUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [visitorId]);
  const payload = credentials ? visitorQrPayload(visitorId, { ...data, ...credentials }) : null;
  const manualCode =
    typeof credentials?.visitorPassCode === 'string' ? credentials.visitorPassCode : null;
  if (unavailable) return <p role="status">This visitor pass is unavailable.</p>;
  if (!payload) return null;

  return (
    <section aria-labelledby="visitor-gate-qr-title" className="visitor-qr-pass">
      <h3 id="visitor-gate-qr-title">Visitor gate QR</h3>
      <QRCodeSVG
        value={payload}
        size={220}
        level="M"
        includeMargin
        aria-label="Visitor gate QR code"
      />
      <p>Show this code to Security at the gate.</p>
      {manualCode && (
        <p>
          Manual pass code: <strong>{manualCode}</strong>
        </p>
      )}
    </section>
  );
}
