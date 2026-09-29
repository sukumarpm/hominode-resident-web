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
  getMany: vi.fn(),
  add: vi.fn(),
  set: vi.fn(),
  update: vi.fn(),
  upload: vi.fn(),
  call: vi.fn(),
  bill: {} as Data,
  config: {} as Data,
  proofs: [] as Data[],
  metadata: vi.fn(),
}));
vi.mock('../firebase', () => ({
  firebase: () => ({ auth: { currentUser: m.user }, db: {}, storage: {} }),
  call: m.call,
}));
vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, name: string) => name,
  doc: (...args: unknown[]) => {
    if (args.length === 1) return { id: 'payment-1', path: 'payments/payment-1' };
    const col = args[1];
    return typeof col === 'string' ? col + '/' + (args[2] ?? 'payment-1') : 'payments/payment-1';
  },
  getDocFromServer: m.get,
  getDocsFromServer: m.getMany,
  addDoc: m.add,
  updateDoc: m.update,
  serverTimestamp: () => 'SERVER_TIMESTAMP',
  Timestamp: { fromDate: (date: Date) => date, now: () => new Date() },
  getDocs: vi.fn(),
  query: (target: unknown, ...constraints: unknown[]) =>
    Object.assign(constraints, { collection: target }),
  where: (field: string, _op: string, value: unknown) => ({ field, value }),
  setDoc: m.set,
}));
vi.mock('firebase/storage', () => ({
  ref: (_storage: unknown, path: string) => path,
  uploadBytes: m.upload,
  getMetadata: m.metadata,
  getBlob: vi.fn(),
}));
import {
  createComplaint,
  createVisitor,
  currentAuthority,
  prepareDirectUpiPayment,
  submitProof,
  latestPaymentForBill,
} from '../actions';
beforeEach(() => {
  vi.clearAllMocks();
  m.user = {
    uid: 'resident-1',
    phoneNumber: '+639171234567',
    getIdTokenResult: async () => ({ signInProvider: 'phone' }),
  };
  m.profile = { ...residentData };
  m.bill = {
    communityId: 'community-1',
    flatId: 'unit-1',
    userId: 'resident-1',
    amount: 850.5,
    status: 'pending',
  };
  m.config = {
    communityId: 'community-1',
    version: 1,
    directUpi: { enabled: true, payeeName: 'Green Valley', vpa: 'greenvalley@okaxis' },
  };
  m.proofs = [];
  localStorage.clear();
  m.get.mockImplementation(async (path: string) => ({
    data: () =>
      path.startsWith('communities/')
        ? { name: 'Green Valley', slug: 'green-valley', isActive: true }
        : path.startsWith('bills/')
          ? m.bill
          : path.startsWith('communityPaymentConfigs/')
            ? m.config
            : m.profile,
  }));
  m.getMany.mockImplementation(async (constraints: { field: string; value: unknown }[]) => {
    const matches = m.proofs.filter((proof) =>
      constraints.every((constraint) => proof[constraint.field] === constraint.value),
    );
    return {
      docs: matches.map((proof) => ({ id: String(proof.id || 'proof-1'), data: () => proof })),
      empty: matches.length === 0,
      size: matches.length,
    };
  });
  m.upload.mockResolvedValue(undefined);
  m.metadata.mockRejectedValue(
    Object.assign(new Error('not found'), { code: 'storage/object-not-found' }),
  );
  m.set.mockResolvedValue(undefined);
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

it('prepares a URI from the authoritative bill and enabled community UPI config', async () => {
  const prepared = await prepareDirectUpiPayment(makeSession(), 'bill-1');
  const uri = new URL(prepared.paymentUri);
  expect(prepared.amount).toBe(850.5);
  expect(prepared.paymentUri).toBe(
    'upi://pay?pa=greenvalley%40okaxis&pn=Green+Valley&am=850.50&cu=INR',
  );
  expect(uri.protocol).toBe('upi:');
  expect(uri.searchParams.get('pa')).toBe('greenvalley@okaxis');
  expect(uri.searchParams.get('pn')).toBe('Green Valley');
  expect(uri.searchParams.get('am')).toBe('850.50');
  expect(uri.searchParams.get('cu')).toBe('INR');
});

it.each(['pending', 'overdue'])(
  'allows direct UPI preparation for %s bills',
  async (billStatus) => {
    m.bill = { ...m.bill, status: billStatus };
    await expect(prepareDirectUpiPayment(makeSession(), 'bill-1')).resolves.toHaveProperty(
      'billId',
      'bill-1',
    );
  },
);

it('rejects settled, non-currency and already-pending bills', async () => {
  m.bill = { ...m.bill, status: 'paid' };
  await expect(prepareDirectUpiPayment(makeSession(), 'bill-1')).rejects.toThrow('not eligible');
  m.bill = { ...m.bill, status: 'pending', amount: 10.999 };
  await expect(prepareDirectUpiPayment(makeSession(), 'bill-1')).rejects.toThrow(
    'represented in INR',
  );
  m.bill = { ...m.bill, amount: 10 };
  m.proofs = [
    {
      communityId: 'community-1',
      flatId: 'unit-1',
      billId: 'bill-1',
      userId: 'resident-1',
      status: 'pending',
    },
  ];
  await expect(prepareDirectUpiPayment(makeSession(), 'bill-1')).rejects.toThrow(
    'already awaiting',
  );
});

it('rejects missing, disabled or invalid community UPI config', async () => {
  m.config = {};
  await expect(prepareDirectUpiPayment(makeSession(), 'bill-1')).rejects.toThrow('not configured');
  m.config = {
    communityId: 'community-1',
    version: 1,
    directUpi: { enabled: false, payeeName: 'Name', vpa: 'name@bank' },
  };
  await expect(prepareDirectUpiPayment(makeSession(), 'bill-1')).rejects.toThrow('not configured');
  m.config = {
    communityId: 'community-1',
    version: 1,
    directUpi: { enabled: true, payeeName: 'Name', vpa: 'invalid' },
  };
  await expect(prepareDirectUpiPayment(makeSession(), 'bill-1')).rejects.toThrow(
    'details are invalid',
  );
});

it('submits legacy-compatible direct UPI proof with trimmed optional reference', async () => {
  const file = new File(['receipt'], 'receipt.png', { type: 'image/png' });
  await submitProof(makeSession(), 'bill-1', file, '  txn-123  ');
  expect(m.upload).toHaveBeenCalledOnce();
  expect(m.set).toHaveBeenCalledWith(
    { id: 'payment-1', path: 'payments/payment-1' },
    expect.objectContaining({
      amount: 850.5,
      provider: 'direct_upi',
      method: 'upi',
      verificationMode: 'manual',
      evidenceType: 'receipt',
      status: 'pending',
      transactionId: 'txn-123',
    }),
  );
  expect(m.upload).toHaveBeenCalledWith(
    'payment_receipts/community-1/bill-1/resident-1/payment-1.png',
    file,
    expect.objectContaining({
      contentType: 'image/png',
      customMetadata: {
        paymentId: 'payment-1',
        billId: 'bill-1',
        communityId: 'community-1',
        residentUid: 'resident-1',
      },
    }),
  );
});

it('stores no transaction id for blank references and enforces the reference limit', async () => {
  const file = new File(['receipt'], 'receipt.jpg', { type: 'image/jpeg' });
  await submitProof(makeSession(), 'bill-1', file, '   ');
  expect(m.set).toHaveBeenCalledWith(
    { id: 'payment-1', path: 'payments/payment-1' },
    expect.objectContaining({ transactionId: null }),
  );
  await submitProof(makeSession(), 'bill-1', file, 'x'.repeat(200));
  expect(m.set).toHaveBeenLastCalledWith(
    { id: 'payment-1', path: 'payments/payment-1' },
    expect.objectContaining({ transactionId: 'x'.repeat(200) }),
  );
  await expect(submitProof(makeSession(), 'bill-1', file, 'x'.repeat(201))).rejects.toThrow(
    '200 characters',
  );
});

it('fresh duplicate proof lookup only blocks an exact scoped pending proof', async () => {
  const file = new File(['receipt'], 'receipt.jpg', { type: 'image/jpeg' });
  m.proofs = [
    {
      communityId: 'community-other',
      flatId: 'unit-1',
      billId: 'bill-1',
      userId: 'resident-1',
      status: 'pending',
    },
    {
      communityId: 'community-1',
      flatId: 'unit-other',
      billId: 'bill-1',
      userId: 'resident-1',
      status: 'pending',
    },
    {
      communityId: 'community-1',
      flatId: 'unit-1',
      billId: 'bill-other',
      userId: 'resident-1',
      status: 'pending',
    },
    {
      communityId: 'community-1',
      flatId: 'unit-1',
      billId: 'bill-1',
      userId: 'resident-other',
      status: 'pending',
    },
    {
      communityId: 'community-1',
      flatId: 'unit-1',
      billId: 'bill-1',
      userId: 'resident-1',
      status: 'failed',
    },
  ];
  await expect(submitProof(makeSession(), 'bill-1', file)).resolves.toBeUndefined();
  m.proofs.push({
    communityId: 'community-1',
    flatId: 'unit-1',
    billId: 'bill-1',
    userId: 'resident-1',
    status: 'pending',
  });
  await expect(submitProof(makeSession(), 'bill-1', file)).rejects.toThrow('already pending');
});

function v2Bill(overrides: Data = {}): Data {
  return {
    schemaVersion: 2,
    currency: 'INR',
    communityId: 'community-1',
    residentId: 'resident-1',
    userId: 'resident-1',
    flatId: 'unit-1',
    status: 'pending',
    amountMinor: 250000,
    paidAmountMinor: 100000,
    creditAppliedMinor: 30000,
    outstandingAmountMinor: 120000,
    currentRevisionId: 'revision-4',
    billingPeriod: '2026-08',
    chargeLines: [{ label: 'Maintenance', amountMinor: 250000 }],
    ...overrides,
  };
}

it('prepares V2 Direct UPI for the exact outstanding minor-unit amount', async () => {
  m.bill = v2Bill({ status: 'partially_paid' });
  const prepared = await prepareDirectUpiPayment(makeSession(), 'bill-1');
  expect(prepared.schemaVersion).toBe(2);
  expect(prepared.amountMinor).toBe(120000);
  expect(prepared.outstandingAmountMinor).toBe(120000);
  expect(new URL(prepared.paymentUri).searchParams.get('am')).toBe('1200.00');
  m.bill = v2Bill({ status: 'partially_paid', outstandingAmountMinor: 123456 });
  const paisePrepared = await prepareDirectUpiPayment(makeSession(), 'bill-1');
  expect(new URL(paisePrepared.paymentUri).searchParams.get('am')).toBe('1234.56');
  expect(m.getMany.mock.calls[0][0].collection).toBe('paymentProofsV2');
});

it('rejects non-INR and zero-outstanding V2 bills before payment preparation', async () => {
  m.bill = v2Bill({ currency: 'USD' });
  await expect(prepareDirectUpiPayment(makeSession(), 'bill-1')).rejects.toThrow('unavailable');
  m.bill = v2Bill({ status: 'partially_paid', outstandingAmountMinor: 0 });
  await expect(prepareDirectUpiPayment(makeSession(), 'bill-1')).rejects.toThrow(
    'no outstanding balance',
  );
});

it('looks up V2 proof state in paymentProofsV2, not V1 payments', async () => {
  const proof = {
    id: 'proof-v2',
    schemaVersion: 2,
    communityId: 'community-1',
    residentId: 'resident-1',
    billId: 'bill-1',
    status: 'pending',
    submittedAt: new Date('2026-08-01T00:00:00Z'),
  };
  m.proofs = [proof];
  m.bill = v2Bill();
  await expect(latestPaymentForBill(makeSession(), 'bill-1', m.bill)).resolves.toMatchObject({
    id: 'proof-v2',
    status: 'pending',
  });
  expect(m.getMany.mock.calls[0][0].collection).toBe('paymentProofsV2');
});

it('submits a new V2 proof using the callable path and exact receipt metadata only', async () => {
  m.bill = v2Bill({ status: 'partially_paid' });
  m.call.mockResolvedValue({
    paymentId: 'proof-v2-new',
    receiptPath: 'payment_receipts/community-1/bill-1/resident-1/proof-v2-new.png',
    status: 'pending',
  });
  const file = new File(['receipt'], 'proof.png', { type: 'image/png' });
  await submitProof(makeSession(), 'bill-1', file, ' REF-22 ');
  expect(m.call).toHaveBeenCalledWith('preparePaymentProofV2', {
    billId: 'bill-1',
    submittedAmountMinor: 120000,
    submittedBillRevisionId: 'revision-4',
    idempotencyKey: expect.any(String),
    receiptExtension: 'png',
    paymentReference: 'REF-22',
  });
  expect(m.upload).toHaveBeenCalledWith(
    'payment_receipts/community-1/bill-1/resident-1/proof-v2-new.png',
    file,
    {
      contentType: 'image/png',
      customMetadata: {
        paymentId: 'proof-v2-new',
        billId: 'bill-1',
        communityId: 'community-1',
        residentUid: 'resident-1',
      },
    },
  );
  expect(m.set).not.toHaveBeenCalled();
});

it('resumes a pending V2 proof at its reserved path without another callable', async () => {
  const file = new File(['receipt'], 'replacement.jpg', { type: 'image/jpeg' });
  m.bill = v2Bill({ status: 'partially_paid' });
  m.proofs = [
    {
      id: 'reserved-proof',
      schemaVersion: 2,
      communityId: 'community-1',
      residentId: 'resident-1',
      userId: 'resident-1',
      billId: 'bill-1',
      currency: 'INR',
      status: 'pending',
      submittedAmountMinor: 98000,
      submittedBillRevisionId: 'revision-3',
      receiptPath: 'payment_receipts/community-1/bill-1/resident-1/reserved-proof.png',
      submittedAt: new Date('2026-08-02T00:00:00Z'),
    },
  ];
  await submitProof(makeSession(), 'bill-1', file);
  expect(m.call).not.toHaveBeenCalled();
  expect(m.upload).toHaveBeenCalledWith(
    'payment_receipts/community-1/bill-1/resident-1/reserved-proof.png',
    file,
    expect.objectContaining({
      contentType: 'image/jpeg',
      customMetadata: {
        paymentId: 'reserved-proof',
        billId: 'bill-1',
        communityId: 'community-1',
        residentUid: 'resident-1',
      },
    }),
  );
});

it('does not overwrite a matching receipt for an existing V2 proof', async () => {
  const file = new File(['replacement'], 'replacement.png', { type: 'image/png' });
  m.bill = v2Bill();
  m.proofs = [
    {
      id: 'reserved-proof',
      schemaVersion: 2,
      communityId: 'community-1',
      residentId: 'resident-1',
      userId: 'resident-1',
      billId: 'bill-1',
      currency: 'INR',
      status: 'pending',
      submittedAmountMinor: 120000,
      submittedBillRevisionId: 'revision-4',
      receiptPath: 'payment_receipts/community-1/bill-1/resident-1/reserved-proof.png',
    },
  ];
  m.metadata.mockResolvedValue({
    fullPath: 'payment_receipts/community-1/bill-1/resident-1/reserved-proof.png',
    size: 100,
    contentType: 'image/png',
    customMetadata: {
      paymentId: 'reserved-proof',
      billId: 'bill-1',
      communityId: 'community-1',
      residentUid: 'resident-1',
    },
  });
  await submitProof(makeSession(), 'bill-1', file);
  expect(m.upload).not.toHaveBeenCalled();
  expect(m.call).not.toHaveBeenCalled();
});

it('allows a rejected V2 proof to create a new idempotent attempt', async () => {
  m.bill = v2Bill();
  m.proofs = [
    {
      id: 'rejected-proof',
      schemaVersion: 2,
      communityId: 'community-1',
      residentId: 'resident-1',
      billId: 'bill-1',
      status: 'failed',
      submittedAt: new Date('2026-08-02T00:00:00Z'),
    },
  ];
  m.call.mockResolvedValue({
    paymentId: 'proof-v2-retry',
    receiptPath: 'payment_receipts/community-1/bill-1/resident-1/proof-v2-retry.jpg',
    status: 'pending',
  });
  await submitProof(makeSession(), 'bill-1', new File(['receipt'], 'proof.jpg'));
  expect(m.call).toHaveBeenCalledWith(
    'preparePaymentProofV2',
    expect.objectContaining({
      submittedAmountMinor: 120000,
      submittedBillRevisionId: 'revision-4',
    }),
  );
});

it('allows another V2 proof attempt after completion when outstanding remains', async () => {
  m.bill = v2Bill({ status: 'partially_paid', outstandingAmountMinor: 40000 });
  m.proofs = [
    {
      id: 'completed-proof',
      schemaVersion: 2,
      communityId: 'community-1',
      residentId: 'resident-1',
      billId: 'bill-1',
      status: 'completed',
      submittedAt: new Date('2026-08-02T00:00:00Z'),
    },
  ];
  m.call.mockResolvedValue({
    paymentId: 'proof-after-completion',
    receiptPath: 'payment_receipts/community-1/bill-1/resident-1/proof-after-completion.jpg',
    status: 'pending',
  });
  await expect(
    submitProof(makeSession(), 'bill-1', new File(['receipt'], 'proof.jpg')),
  ).resolves.toMatchObject({ status: 'pending' });
  expect(m.call).toHaveBeenCalledWith(
    'preparePaymentProofV2',
    expect.objectContaining({ submittedAmountMinor: 40000 }),
  );
});
