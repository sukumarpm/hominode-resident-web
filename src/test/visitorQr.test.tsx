import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisitorQrPass, visitorQrPayload } from '../components/VisitorQrPass';
import { makeSession } from './fixtures';
const callMock = vi.hoisted(() => vi.fn());
vi.mock('../firebase', () => ({ call: callMock }));
const token = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno12';
const now = Date.UTC(2026, 10, 9, 10),
  manual = 'ABCD-EFGHJKLM';
const row = { status: 'expected', isApproved: false, expectedArrival: new Date(now + 3600000) };
const credentials = { qrToken: token, visitorPassCode: manual };
beforeEach(() => {
  callMock.mockReset();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  callMock.mockResolvedValue(credentials);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('private Resident QR/manual pass', () => {
  it('requires a validated private response and never falls back to a public token or document ID', () => {
    expect(visitorQrPayload('visitor-1', { ...row, qrToken: token }, now)).toBeNull();
    expect(visitorQrPayload('visitor-1', row, now, credentials)).toBe(
      JSON.stringify({ type: 'hominode_visitor', version: 1, token }),
    );
    for (const response of [{}, { qrToken: 'short-token' }, { ...credentials, legacy: true }])
      expect(visitorQrPayload('visitor-1', row, now, response)).toBeNull();
  });
  it('loads private QR and manual code without rendering or logging the raw QR token', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const { container } = render(
      <VisitorQrPass
        visitorId="visitor-1"
        data={{ ...row, qrToken: 'public-forgery', visitorPassCode: 'PUBLIC' }}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('Visitor gate QR code')).toBeInTheDocument());
    expect(container.textContent).toContain(manual);
    expect(container.innerHTML).not.toContain(token);
    expect(container.textContent).not.toContain('PUBLIC');
    expect(callMock).toHaveBeenCalledWith('getVisitorCredentials', { visitorId: 'visitor-1' });
    logs.forEach((log) => expect(log).not.toHaveBeenCalled());
  });
  for (const state of ['rejected', 'revoked', 'unknown'])
    it(`does not request or show credentials for ${state}`, async () => {
      const { container } = render(
        <VisitorQrPass
          visitorId="visitor-1"
          data={{ ...row, authorizationManaged: true, authorizationState: state }}
        />,
      );
      expect(container.querySelector('svg')).toBeNull();
      expect(callMock).not.toHaveBeenCalled();
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
  it('refreshes on Admin approval and removes credentials immediately on revocation', async () => {
    callMock.mockRejectedValueOnce(Object.assign(Error('Admin approval required'), {
      code: 'functions/failed-precondition',
    }));
    const view = render(
      <VisitorQrPass
        visitorId="visitor-1"
        data={{ ...row, authorizationState: 'pending_admin' }}
      />,
    );
    await screen.findByText('Admin approval required');
    expect(screen.queryByLabelText('Visitor gate QR code')).not.toBeInTheDocument();
    view.rerender(
      <VisitorQrPass
        visitorId="visitor-1"
        data={{
          ...row,
          authorizationState: 'admin_authorized',
          authorizationRevision: 2,
          status: 'approved',
          isApproved: true,
        }}
      />,
    );
    await screen.findByLabelText('Visitor gate QR code');
    view.rerender(
      <VisitorQrPass
        visitorId="visitor-1"
        data={{ ...row, authorizationState: 'revoked', authorizationRevision: 3 }}
      />,
    );
    expect(screen.queryByLabelText('Visitor gate QR code')).not.toBeInTheDocument();
    expect(screen.queryByText(manual, { exact: false })).not.toBeInTheDocument();
  });
  it('discards a late credential response after the invitation changes', async () => {
    let resolve!: (value: typeof credentials) => void;
    callMock.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<VisitorQrPass visitorId="visitor-1" data={row} />);
    view.rerender(
      <VisitorQrPass
        visitorId="visitor-1"
        data={{ ...row, status: 'cancelled', authorizationState: 'revoked' }}
      />,
    );
    await act(async () => resolve(credentials));
    expect(screen.queryByLabelText('Visitor gate QR code')).not.toBeInTheDocument();
  });
  for (const response of [
    { qrToken: token },
    { ...credentials, legacy: true },
    { qrToken: 'bad', visitorPassCode: manual },
  ])
    it('rejects malformed or legacy credentials without inventing a replacement', async () => {
      callMock.mockResolvedValue(response);
      render(<VisitorQrPass visitorId="visitor-1" data={row} />);
      await screen.findByText(/must be replaced/);
      expect(screen.queryByLabelText('Visitor gate QR code')).not.toBeInTheDocument();
    });
  it('handles private retrieval failure and offers explicit retry', async () => {
    callMock.mockRejectedValueOnce(
      Object.assign(Error('private detail'), { code: 'permission-denied' }),
    );
    render(<VisitorQrPass visitorId="visitor-1" data={row} />);
    await screen.findByText(/Visitor access denied/);
    fireEvent.click(screen.getByText('Reload pass'));
    await screen.findByLabelText('Visitor gate QR code');
  });
  it('hides expired, checked-in and denied passes', () => {
    for (const data of [
      { ...row, expectedArrival: new Date(now - 25 * 3600000) },
      { ...row, actualArrival: new Date(now) },
      { ...row, gateAccessStatus: 'denied' },
    ])
      expect(visitorQrPayload('visitor-1', data, now, credentials)).toBeNull();
  });

  it('clears a cached pass at a server deadline before a delayed denial arrives', async () => {
    vi.useFakeTimers();
    // Server and device clocks deliberately differ.
    callMock.mockResolvedValueOnce({ ...credentials, serverTime: 1000, revalidateAt: 2000 })
      .mockReturnValueOnce(new Promise(() => {}));
    render(<VisitorQrPass visitorId="visitor-1" data={row} />);
    await act(async () => {});
    expect(screen.getByLabelText('Visitor gate QR code')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(callMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText('Visitor gate QR code')).not.toBeInTheDocument();
    expect(screen.queryByText(manual, { exact: false })).not.toBeInTheDocument();
  });

  it('uses denial timing to recover after emergency expiry without a Firestore write', async () => {
    vi.useFakeTimers();
    callMock.mockRejectedValueOnce(Object.assign(Error('Admin approval required'), {
      code: 'functions/failed-precondition', details: { serverTime: 5000, revalidateAt: 6000 },
    }));
    render(<VisitorQrPass visitorId="visitor-1" data={{ ...row,
      authorizationManaged: true, authorizationState: 'pending_admin' }} />);
    await act(async () => {});
    expect(screen.getByText('Admin approval required')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByLabelText('Visitor gate QR code')).toBeInTheDocument();
    expect(screen.getByText(/Pass availability confirmed under the current community policy/)).toBeInTheDocument();
  });

  it.each([
    { enabled: false, approvalMode: 'all_approval_required' },
    { enabled: true, approvalMode: 'resident_authorized' },
  ])('rechecks stored pending invitations after policy relaxation: %j', async policy => {
    const session = makeSession();
    const data = { ...row, communityId: session.community!.id, hostUserId: session.uid,
      authorizationManaged: true, authorizationState: 'pending_admin' };
    const watchCommunity = () => () => {};
    callMock.mockRejectedValueOnce(Object.assign(Error('Admin approval required'), {
      code: 'functions/failed-precondition',
    }));
    const view = render(<VisitorQrPass visitorId="visitor-1" data={data} session={session}
      watchCommunity={watchCommunity} />);
    await screen.findByText('Admin approval required');
    expect(screen.queryByLabelText('Visitor gate QR code')).not.toBeInTheDocument();
    let finish!: (value: typeof credentials) => void;
    callMock.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    view.rerender(<VisitorQrPass visitorId="visitor-1" data={data} session={{ ...session,
      community: { ...session.community!, data: { ...session.community!.data,
        visitorPolicy: { ...policy, revision: 5 } } },
    }} watchCommunity={watchCommunity} />);
    expect(screen.queryByLabelText('Visitor gate QR code')).not.toBeInTheDocument();
    await act(async () => { finish(credentials); });
    expect(screen.getByLabelText('Visitor gate QR code')).toBeInTheDocument();
    expect(callMock).toHaveBeenCalledTimes(2);
    expect(data.authorizationState).toBe('pending_admin');
  });

  it('discards a late pending-pass response after a newer policy denies availability', async () => {
    const session = makeSession();
    const data = { ...row, communityId: session.community!.id, hostUserId: session.uid,
      authorizationManaged: true, authorizationState: 'pending_admin' };
    const watchCommunity = () => () => {};
    let finish!: (value: typeof credentials) => void;
    callMock.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockRejectedValueOnce(Object.assign(Error('Admin approval required'), {
        code: 'functions/failed-precondition',
      }));
    const view = render(<VisitorQrPass visitorId="visitor-1" data={data} session={session}
      watchCommunity={watchCommunity} />);
    view.rerender(<VisitorQrPass visitorId="visitor-1" data={data} session={{ ...session,
      community: { ...session.community!, data: { ...session.community!.data,
        visitorPolicy: { enabled: true, approvalMode: 'all_approval_required', revision: 6 } } },
    }} watchCommunity={watchCommunity} />);
    await screen.findByText('Admin approval required');
    await act(async () => { finish(credentials); });
    expect(screen.queryByLabelText('Visitor gate QR code')).not.toBeInTheDocument();
    expect(screen.queryByText(manual, { exact: false })).not.toBeInTheDocument();
  });

  it('does not display a response delayed beyond its server revalidation deadline', async () => {
    vi.useFakeTimers();
    let finish!: (value: typeof credentials & { serverTime: number; revalidateAt: number }) => void;
    callMock.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockReturnValueOnce(new Promise(() => {}));
    render(<VisitorQrPass visitorId="visitor-1" data={row} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await act(async () => { finish({ ...credentials, serverTime: 1000, revalidateAt: 2000 }); });
    expect(screen.queryByLabelText('Visitor gate QR code')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(callMock).toHaveBeenCalledTimes(2);
  });

  it('discards credentials immediately when a pending policy schedule changes in the session', async () => {
    const session = makeSession();
    const watchCommunity = () => () => {};
    const view = render(<VisitorQrPass visitorId="visitor-1" data={row} session={session}
      watchCommunity={watchCommunity} />);
    // Use this Resident's scoped visitor.
    const data = { ...row, hostUserId: session.uid, communityId: session.community!.id };
    view.rerender(<VisitorQrPass visitorId="visitor-1" data={data} session={session}
      watchCommunity={watchCommunity} />);
    await screen.findByLabelText('Visitor gate QR code');
    callMock.mockReturnValueOnce(new Promise(() => {}));
    view.rerender(<VisitorQrPass visitorId="visitor-1" data={data} session={{ ...session,
      community: { ...session.community!, data: { ...session.community!.data,
        scheduledVisitorPolicy: { revision: 5, effectiveAt: now + 1000 } } },
    }} watchCommunity={watchCommunity} />);
    expect(screen.queryByLabelText('Visitor gate QR code')).not.toBeInTheDocument();
  });

  it.each([{ status: 'cancelled' }, { authorizationState: 'rejected' }, { authorizationState: 'revoked' },
    { expectedArrival: new Date(now - 25 * 3600000) }, { status: 'unknown' },
    { checkInTime: new Date(now) }, { checkOutTime: new Date(now) }, { departure: new Date(now) }])
    ('removes an already displayed pass after a terminal or entry update: %j', async extra => {
      const pending = { ...row, authorizationManaged: true, authorizationState: 'pending_admin' };
      const view = render(<VisitorQrPass visitorId="visitor-1" data={pending} />);
      await screen.findByLabelText('Visitor gate QR code');
      view.rerender(<VisitorQrPass visitorId="visitor-1" data={{ ...pending, ...extra }} />);
      expect(screen.queryByLabelText('Visitor gate QR code')).not.toBeInTheDocument();
      expect(screen.queryByText(manual, { exact: false })).not.toBeInTheDocument();
    });
});
