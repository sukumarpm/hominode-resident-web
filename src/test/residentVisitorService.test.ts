import { beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeSession } from './fixtures';
import { mutateResidentVisitor, visitorContext, watchResidentVisitorCommunity } from '../residentVisitorService';
const mock = vi.hoisted(() => ({ call: vi.fn(), authority: vi.fn(), watch: vi.fn() }));
vi.mock('../firebase', () => ({ call: mock.call, firebase: () => ({ db: {} }) }));
vi.mock('firebase/firestore', () => ({ doc: vi.fn(), onSnapshot: mock.watch }));
vi.mock('../actions', () => ({ currentAuthority: mock.authority }));
const shared = JSON.parse(
  fs.readFileSync(path.resolve('../lyvo1/docs/fixtures/resident_visitor_contract.json'), 'utf8'),
);
const row = {
  id: 'visitor-1',
  data: {
    communityId: 'community-1',
    hostUserId: 'resident-1',
    residentId: 'resident-1',
    authorizationRevision: 7,
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  mock.authority.mockImplementation(async (s) => s);
  mock.call.mockResolvedValue({
    visitorId: 'visitor-1',
    authorizationState: 'revoked',
    authorizationRevision: 8,
  });
});
it('uses exact shared cancellation/rescheduling contracts without scope, credentials or status writes', async () => {
  await mutateResidentVisitor(makeSession(), row, 'cancel');
  expect(mock.call).toHaveBeenCalledWith('mutateResidentVisitor', shared.cancel);
  const session = makeSession();
  session.community!.data.timeZone = 'Asia/Manila';
  await mutateResidentVisitor(session, row, 'reschedule', {
    expectedArrival: shared.create.expectedArrival,
    bringingPet: false,
  });
  expect(mock.call).toHaveBeenCalledWith('mutateResidentVisitor', shared.reschedule);
});
it('gets authoritative advisory context with only the visit instant', async () => {
  mock.call.mockResolvedValue(shared.context);
  expect(await visitorContext(makeSession(), shared.create.expectedArrival)).toEqual(
    shared.context,
  );
  expect(mock.call).toHaveBeenCalledWith('getResidentVisitorContext', shared.contextRequest);
});
it('rejects cross-community, wrong-host, inactive and unverified authority failures', async () => {
  for (const extra of [
    { communityId: 'foreign' },
    { hostUserId: 'foreign' },
    { residentId: 'foreign' },
  ])
    await expect(
      mutateResidentVisitor(makeSession(), { ...row, data: { ...row.data, ...extra } }, 'cancel'),
    ).rejects.toThrow(/outside/);
  expect(mock.call).not.toHaveBeenCalled();
  for (const reason of ['inactive', 'verification required', 'invalid unit']) {
    mock.authority.mockRejectedValueOnce(Error(reason));
    await expect(mutateResidentVisitor(makeSession(), row, 'cancel')).rejects.toThrow(reason);
  }
});
it('rejects mismatched community guidance and incomplete mutation acknowledgements', async () => {
  mock.call.mockResolvedValue({ ...shared.context, communityId: 'foreign' });
  await expect(visitorContext(makeSession(), shared.create.expectedArrival)).rejects.toThrow(
    /unavailable/,
  );
  mock.call.mockResolvedValue({});
  await expect(mutateResidentVisitor(makeSession(), row, 'cancel')).rejects.toThrow(
    /could not be confirmed/,
  );
});

it('watches pending-only schedule changes and replacements even when the active revision is unchanged', () => {
  const session = makeSession(), changed = vi.fn();
  const stop = vi.fn();
  mock.watch.mockReturnValue(stop);
  const unsubscribe = watchResidentVisitorCommunity(session, changed, vi.fn());
  const snapshot = mock.watch.mock.calls[0][1];
  snapshot({ data: () => session.community!.data });
  expect(changed).not.toHaveBeenCalled();
  const community = { ...session.community!.data, visitorPolicy: { revision: 4 } };
  snapshot({ data: () => community });
  changed.mockClear();
  for (const revision of [5, 6])
    snapshot({ data: () => ({ ...community, scheduledVisitorPolicy: { revision, effectiveAt: 9000 } }) });
  expect(changed).toHaveBeenCalledTimes(2);
  snapshot({ data: () => community });
  expect(changed).toHaveBeenCalledTimes(3);
  unsubscribe();
  expect(stop).toHaveBeenCalledOnce();
});
