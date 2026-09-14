import { beforeEach, it, expect, vi } from 'vitest';
import { makeSession, residentData, adminData } from './fixtures';
import { type Data } from '../models';
const m = vi.hoisted(() => ({
  user: {
    uid: 'resident-1',
    phoneNumber: '+639171234567',
    getIdTokenResult: async () => ({ signInProvider: 'phone' }),
  } as {
    uid: string;
    phoneNumber: string;
    getIdTokenResult: () => Promise<{ signInProvider: string }>;
  } | null,
  profile: {} as Data,
  get: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  upload: vi.fn(),
  call: vi.fn(),
}));
vi.mock('../firebase', () => ({
  firebase: () => ({ auth: { currentUser: m.user }, db: {}, storage: {} }),
  call: m.call,
}));
vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, name: string) => name,
  doc: (_db: unknown, col: string, id: string) => col + '/' + id,
  getDocFromServer: m.get,
  addDoc: m.add,
  updateDoc: m.update,
  serverTimestamp: () => 'SERVER_TIMESTAMP',
  Timestamp: { fromDate: (date: Date) => date, now: () => new Date() },
  getDocs: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  setDoc: vi.fn(),
}));
vi.mock('firebase/storage', () => ({ ref: vi.fn(), uploadBytes: m.upload, getBlob: vi.fn() }));
import { createComplaint, createVisitor, currentAuthority, submitProof } from '../actions';
beforeEach(() => {
  vi.clearAllMocks();
  m.user = {
    uid: 'resident-1',
    phoneNumber: '+639171234567',
    getIdTokenResult: async () => ({ signInProvider: 'phone' }),
  };
  m.profile = { ...residentData };
  m.get.mockImplementation(async (path: string) => ({
    data: () =>
      path.startsWith('communities/')
        ? { name: 'Green Valley', slug: 'green-valley', isActive: true }
        : m.profile,
  }));
});
it('creates complaints with canonical ownership and pending status', async () => {
  await createComplaint(makeSession(), {
    title: 'Broken tap',
    description: 'Kitchen tap is leaking',
    category: 'Plumbing',
  });
  expect(m.add).toHaveBeenCalledWith(
    'complaints',
    expect.objectContaining({
      userId: 'resident-1',
      residentId: 'resident-1',
      communityId: 'community-1',
      flatId: 'unit-1',
      status: 'pending',
      category: 'plumbing',
      createdAt: 'SERVER_TIMESTAMP',
    }),
  );
});
it('creates expected visitor passes without granting entry', async () => {
  await createVisitor(makeSession(), {
    visitorName: 'Test Visitor',
    purpose: 'Friend',
    expectedArrival: '2099-09-09T12:00',
  });
  const payload = m.add.mock.calls[0][1];
  expect(payload).toEqual(
    expect.objectContaining({
      communityId: 'community-1',
      hostUserId: 'resident-1',
      flatId: 'unit-1',
      status: 'expected',
      isApproved: false,
      approvedBy: null,
      approvedAt: null,
      actualArrival: null,
      departure: null,
    }),
  );
  expect(payload.visitorPassCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  expect(payload.qrToken).toHaveLength(32);
  expect(payload).not.toHaveProperty('checkedInAt');
});
it('refuses stale unit assignments before writing', async () => {
  m.profile = { ...residentData, flatId: 'different-unit' };
  await expect(
    createComplaint(makeSession(), { title: 'Test', description: 'Test', category: 'other' }),
  ).rejects.toThrow('assignment changed');
  expect(m.add).not.toHaveBeenCalled();
});
it('refuses expired authentication before reading or writing data', async () => {
  m.user = null;
  await expect(currentAuthority(makeSession())).rejects.toThrow('Sign in again');
  expect(m.get).not.toHaveBeenCalled();
});
it('revalidates current admin assignments before mutations', async () => {
  const session = makeSession('admin');
  m.user = {
    uid: 'admin-1',
    phoneNumber: '+639171234567',
    getIdTokenResult: async () => ({ signInProvider: 'phone' }),
  };
  m.profile = { ...adminData, authorizedCommunityIds: ['community-2'] };
  await expect(currentAuthority(session)).rejects.toThrow('Community access revoked');
});
it('rejects invalid receipt files without uploading', async () => {
  await expect(
    submitProof(makeSession(), 'bill-1', new File(['text'], 'receipt.txt', { type: 'text/plain' })),
  ).rejects.toThrow('Choose a JPG');
  expect(m.upload).not.toHaveBeenCalled();
});
