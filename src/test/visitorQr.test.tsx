import { act, render, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisitorQrPass, visitorQrPayload } from '../components/VisitorQrPass';

const callMock = vi.hoisted(() => vi.fn());
vi.mock('../firebase', () => ({ call: callMock }));

const now = new Date('2026-10-10T10:00:00.000Z');
const upcoming = {
  status: 'expected',
  isApproved: false,
  expectedArrival: new Date(now.getTime() + 60 * 60 * 1000),
};

describe('Resident visitor gate QR', () => {
  beforeEach(() => {
    callMock.mockReset();
    vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
  });
  afterEach(() => vi.restoreAllMocks());

  it('uses the persisted token in the payload Security accepts without changing it on view', () => {
    const data = { ...upcoming, qrToken: 'persisted-secret-token' };
    const first = visitorQrPayload('visitor-1', data, now.getTime());
    const second = visitorQrPayload('visitor-1', data, now.getTime());

    expect(first).toBe(
      JSON.stringify({
        type: 'hominode_visitor',
        version: 1,
        token: 'persisted-secret-token',
      }),
    );
    expect(second).toBe(first);
  });

  it('retrieves the persisted host credential and renders it without printing the QR token', async () => {
    const token = 'persisted-secret-token';
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    let resolveCredentials!: (value: { qrToken: string; visitorPassCode: string }) => void;
    callMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCredentials = resolve;
      }),
    );
    const { container } = render(<VisitorQrPass visitorId="visitor-1" data={upcoming} />);

    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).not.toContain('ABCD-EFGHJKLM');
    await act(async () => {
      resolveCredentials({ qrToken: token, visitorPassCode: 'ABCD-EFGHJKLM' });
    });
    await waitFor(() =>
      expect(container.querySelector('svg[aria-label="Visitor gate QR code"]')).not.toBeNull(),
    );
    const expectedQr = document.createElement('div');
    expectedQr.innerHTML = renderToStaticMarkup(
      <QRCodeSVG
        value={JSON.stringify({ type: 'hominode_visitor', version: 1, token })}
        size={220}
        level="M"
        includeMargin
      />,
    );
    expect(container.querySelector('svg')?.innerHTML).toBe(
      expectedQr.querySelector('svg')?.innerHTML,
    );
    expect(container.textContent).not.toContain(token);
    expect(container.innerHTML).not.toContain(token);
    expect(container.textContent).toContain('ABCD-EFGHJKLM');
    expect(callMock).toHaveBeenCalledWith('getVisitorCredentials', { visitorId: 'visitor-1' });
    expect(callMock).toHaveBeenCalledOnce();
    logs.forEach((log) => expect(log).not.toHaveBeenCalled());
  });

  it.each(['permission-denied', 'unavailable'])(
    'does not render a QR or fall back to a visitor ID when credential retrieval fails (%s)',
    async (code) => {
      callMock.mockRejectedValue(Object.assign(Error('Private credential error'), { code }));
      const { container, findByRole } = render(
        <VisitorQrPass visitorId="visitor-1" data={upcoming} />,
      );
      expect(await findByRole('status')).toHaveTextContent('This visitor pass is unavailable.');
      expect(container.querySelector('svg')).toBeNull();
      expect(container.textContent).not.toContain('Private credential error');
      expect(container.textContent).not.toContain('visitor-1');
    },
  );

  it('supports legacy records without minting a token', () => {
    expect(visitorQrPayload('legacy-visitor', upcoming, now.getTime())).toBe(
      JSON.stringify({ visitorId: 'legacy-visitor', legacy: true }),
    );
    expect(visitorQrPayload('legacy-visitor', { ...upcoming, qrToken: null }, now.getTime())).toBe(
      JSON.stringify({ visitorId: 'legacy-visitor', legacy: true }),
    );
  });

  it('hides passes outside the gate validity window and for non-entry states', () => {
    expect(
      visitorQrPayload(
        'visitor-1',
        { ...upcoming, expectedArrival: new Date(now.getTime() + 25 * 60 * 60 * 1000) },
        now.getTime(),
      ),
    ).toBeNull();
    expect(
      visitorQrPayload('visitor-1', { ...upcoming, actualArrival: now }, now.getTime()),
    ).toBeNull();
    expect(
      visitorQrPayload('visitor-1', { ...upcoming, status: 'rejected' }, now.getTime()),
    ).toBeNull();
    expect(visitorQrPayload('visitor-1', { ...upcoming, qrToken: '' }, now.getTime())).toBeNull();
  });
});
