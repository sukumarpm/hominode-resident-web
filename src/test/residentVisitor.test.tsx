import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { RecordList } from '../Dashboard';
import fs from 'node:fs';
import path from 'node:path';
import { ResidentVisitorForm } from '../components/ResidentVisitorForm';
import { ResidentVisitorActions } from '../components/ResidentVisitorActions';
import { makeSession } from './fixtures';
import {
  petVisitMessage,
  visitorAuthorization,
  visitorPhysicalState,
  visitorArrival,
  visitorLocalTime,
} from '../residentVisitor';
const m = vi.hoisted(() => ({ create: vi.fn(), context: vi.fn(), mutate: vi.fn() }));
vi.mock('../actions', () => ({ createVisitor: m.create, currentAuthority: vi.fn() }));
vi.mock('../residentVisitorService', async (original) => ({
  ...(await original<typeof import('../residentVisitorService')>()),
  visitorContext: m.context,
  mutateResidentVisitor: m.mutate,
}));
const shared = JSON.parse(
  fs.readFileSync(path.resolve('../lyvo1/docs/fixtures/resident_visitor_contract.json'), 'utf8'),
);
const session = () => ({
  ...makeSession(),
  community: {
    ...makeSession().community!,
    data: { ...makeSession().community!.data, timeZone: 'Asia/Manila' },
  },
});
const row = () => ({
  id: 'visitor-1',
  data: {
    communityId: 'community-1',
    hostUserId: 'resident-1',
    residentId: 'resident-1',
    visitorName: 'Guest',
    purpose: 'Visit',
    status: 'expected',
    authorizationState: 'pending_admin',
    authorizationRevision: 7,
    expectedArrival: new Date(Date.now() + 3600000),
    bringingPet: true,
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  m.create.mockResolvedValue(shared.pending);
  m.context.mockResolvedValue({ ...shared.context, petPermitted: true });
  m.mutate.mockResolvedValue({
    visitorId: 'visitor-1',
    authorizationState: 'revoked',
    authorizationRevision: 8,
  });
});
async function fill() {
  fireEvent.change(screen.getByLabelText('Visitor name'), { target: { value: 'Contract Guest' } });
  fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'Visit' } });
  fireEvent.change(screen.getByLabelText('Expected arrival'), {
    target: { value: visitorLocalTime(Date.now() + 2 * 3600000, 'Asia/Manila') },
  });
}
it('pet disclosure defaults false, submits an actual boolean, and does not infer authorization', async () => {
  const saved = vi.fn();
  render(<ResidentVisitorForm session={session()} onClose={vi.fn()} onSaved={saved} />);
  await fill();
  expect(screen.getByLabelText('Visitor will bring a pet')).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Invite Visitor' }));
  await waitFor(() => expect(m.create).toHaveBeenCalled());
  expect(m.create.mock.calls[0][2]).toBe(false);
  expect(saved).toHaveBeenCalledWith(shared.pending);
});
it('pet prohibition uses generic wording and the checkbox can be cleared to continue', async () => {
  m.context.mockResolvedValue({ ...shared.context, petPermitted: false });
  render(<ResidentVisitorForm session={session()} onClose={vi.fn()} />);
  await fill();
  fireEvent.click(screen.getByLabelText('Visitor will bring a pet'));
  await screen.findByText(petVisitMessage);
  expect(screen.getByRole('button', { name: 'Invite Visitor' })).toBeDisabled();
  expect(screen.queryByText(/permanent|temporary restriction/i)).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Visitor will bring a pet'));
  fireEvent.click(screen.getByRole('button', { name: 'Invite Visitor' }));
  await waitFor(() => expect(m.create).toHaveBeenCalled());
  expect(m.create.mock.calls[0][2]).toBe(false);
});
it('server pet validation is authoritative even when guidance had allowed it', async () => {
  m.create.mockRejectedValue(
    Object.assign(Error(petVisitMessage), { code: 'functions/failed-precondition' }),
  );
  render(<ResidentVisitorForm session={session()} onClose={vi.fn()} />);
  await fill();
  fireEvent.click(screen.getByLabelText('Visitor will bring a pet'));
  fireEvent.click(screen.getByRole('button', { name: 'Invite Visitor' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent(petVisitMessage);
  expect(m.create.mock.calls[0][2]).toBe(true);
});
it('locks duplicate submissions and does not report success before confirmation', async () => {
  let complete!: (v: typeof shared.pending) => void;
  m.create.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const saved = vi.fn();
  const close = vi.fn();
  render(<ResidentVisitorForm session={session()} onClose={close} onSaved={saved} />);
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Invite Visitor' }));
  expect(saved).not.toHaveBeenCalled();
  const escape = new Event('cancel', { cancelable: true, bubbles: true });
  fireEvent(screen.getByRole('dialog'), escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
  expect(m.create).toHaveBeenCalledTimes(1);
  await act(async () => complete(shared.pending));
  expect(saved).toHaveBeenCalledWith(shared.pending);
});
it('cancellation requires confirmation, preserves the displayed revision and waits for the backend', async () => {
  const value = row();
  render(<ResidentVisitorActions session={session()} row={value} />);
  fireEvent.click(screen.getByText('Cancel invitation'));
  expect(m.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Confirm cancellation'));
  await screen.findByText(/Cancellation confirmed/);
  expect(m.mutate).toHaveBeenCalledWith(expect.anything(), value, 'cancel');
  expect(value.data.status).toBe('expected');
});
it('stale cancellation gives a meaningful error and prevents repeated actions until refresh', async () => {
  m.mutate.mockRejectedValue(Object.assign(Error('conflict'), { code: 'functions/aborted' }));
  render(<ResidentVisitorActions session={session()} row={row()} />);
  fireEvent.click(screen.getByText('Cancel invitation'));
  fireEvent.click(screen.getByText('Confirm cancellation'));
  await screen.findByText(/This invitation changed/);
  expect(screen.queryByText('Cancel invitation')).not.toBeInTheDocument();
});
it('rescheduling can remove a pet without changing the existing time', async () => {
  const value = row();
  render(<ResidentVisitorForm session={session()} row={value} onClose={vi.fn()} />);
  fireEvent.click(screen.getByLabelText('Visitor will bring a pet'));
  fireEvent.click(screen.getByRole('button', { name: 'Save new visit' }));
  await waitFor(() => expect(m.mutate).toHaveBeenCalled());
  expect(m.mutate.mock.calls[0][3]).toEqual({ bringingPet: false });
});
it('status labels keep authorization separate from physical entry and legacy metadata', () => {
  const base = row().data;
  for (const state of [
    'auto_authorized',
    'admin_authorized',
    'pending_admin',
    'rejected',
    'revoked',
  ])
    expect(visitorAuthorization({ ...base, authorizationState: state })).not.toContain('Unknown');
  expect(visitorPhysicalState({ ...base, authorizationState: 'admin_authorized' })).toBe(
    'Expected',
  );
  expect(
    visitorPhysicalState({
      ...base,
      actualArrival: new Date(),
      authorizationState: 'admin_authorized',
    }),
  ).toBe('Checked in');
  expect(visitorPhysicalState({ ...base, departure: new Date() })).toBe('Checked out');
  for (const state of ['rejected', 'revoked']) {
    const value = { ...base, authorizationState: state, status: state === 'rejected' ? 'rejected' : 'expected' };
    expect(visitorPhysicalState(value)).toBe('Not checked in');
    expect(visitorPhysicalState(value)).not.toBe(visitorAuthorization(value));
  }
  expect(
    visitorAuthorization({ ...base, authorizationState: undefined, isApproved: true }),
  ).toContain('Legacy');
});

it('Recent Visitors separates visit state from authorization without duplicate status labels', () => {
  const value = row();
  value.data.authorizationState = 'rejected';
  value.data.status = 'rejected';
  render(<MemoryRouter><RecordList module="visitors" base="/green-valley/"
    resource={{ rows: [value], loading: false, error: '' }} /></MemoryRouter>);
  expect(screen.getByText('Not checked in', { exact: true })).toBeInTheDocument();
  expect(screen.getAllByText(/Rejected/)).toHaveLength(1);
  expect(screen.getByText('Authorization: Rejected', { exact: true })).toBeInTheDocument();
});
it('community time conversion is stable and refuses ambiguous DST selections', () => {
  expect(visitorArrival('2026-11-10T08:00', 'Asia/Manila')).toBe(shared.create.expectedArrival);
  for (const value of ['2026-03-08T02:30', '2026-11-01T01:30'])
    expect(() => visitorArrival(value, 'America/New_York')).toThrow(/daylight saving/);
});
it('foreign Resident records never expose mutation controls', () => {
  render(
    <ResidentVisitorActions
      session={session()}
      row={{ ...row(), data: { ...row().data, hostUserId: 'someone-else' } }}
    />,
  );
  expect(screen.queryByText('Cancel invitation')).not.toBeInTheDocument();
  expect(m.mutate).not.toHaveBeenCalled();
});

it('reschedule input displays India community time and submits the changed UTC instant once', async () => {
  const s = session(); s.community.data.timeZone = 'Asia/Calcutta';
  const value = row(); value.data.expectedArrival = new Date('2036-11-14T17:02:47Z');
  render(<ResidentVisitorForm session={s} row={value} onClose={vi.fn()} />);
  expect(screen.getByLabelText('Expected arrival')).toHaveValue('2036-11-14T22:32');
  expect(screen.getByText(/Community time/)).toHaveTextContent('Asia/Kolkata');
  fireEvent.change(screen.getByLabelText('Expected arrival'), {target: {value: '2036-11-14T23:32'}});
  fireEvent.click(screen.getByRole('button', {name: 'Save new visit'}));
  await waitFor(() => expect(m.mutate).toHaveBeenCalled());
  expect(m.mutate.mock.calls[0][3].expectedArrival).toBe(Date.parse('2036-11-14T18:02Z'));
});
it('unchanged DST-fold appointment retains its original instant and seconds', async () => {
  const s = session(); s.community.data.timeZone = 'Europe/London';
  const value = row(); value.data.expectedArrival = new Date('2036-10-26T01:30:47Z');
  render(<ResidentVisitorForm session={s} row={value} onClose={vi.fn()} />);
  expect(screen.getByLabelText('Expected arrival')).toHaveValue('2036-10-26T01:30');
  fireEvent.click(screen.getByRole('button', {name: 'Save new visit'}));
  await waitFor(() => expect(m.mutate).toHaveBeenCalled());
  expect(m.mutate.mock.calls[0][3]).toEqual({bringingPet: true});
  expect(value.data.expectedArrival.toISOString()).toBe('2036-10-26T01:30:47.000Z');
});
it.each([undefined, '', 'Invalid/Zone'])('reports invalid timezone %s without crashing a reschedule form', zone => {
  const s = makeSession(); s.community!.data.timeZone = zone;
  render(<ResidentVisitorForm session={s} row={row()} onClose={vi.fn()} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Community Admin');
  expect(screen.getByRole('button', {name: 'Save new visit'})).toBeDisabled();
  expect(m.mutate).not.toHaveBeenCalled();
});
