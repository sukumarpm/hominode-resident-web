import {
  addDoc,
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { getBlob, getMetadata, ref, uploadBytes } from 'firebase/storage';
import { call, firebase } from './firebase';
import { type Data, type DirectUpiPaymentPreparation, type Session, str } from './models';
import { assertResident, assertScope, parseCommunity, parseProfile } from './policy';
export async function currentAuthority(s: Session) {
  const f = firebase();
  const user = f.auth.currentUser;
  if (!user || user.uid !== s.uid) throw Error('Sign in again to continue.');
  const token = await user.getIdTokenResult();
  if (token.signInProvider !== 'phone') throw Error('Phone verification is required.');
  const profileDoc = await getDocFromServer(
    doc(f.db, s.role === 'resident' ? 'users' : 'admins', s.uid),
  );
  const profile = parseProfile(
    s.uid,
    profileDoc.data() || {},
    s.role === 'resident' ? 'resident' : 'admin',
    user.phoneNumber || '',
  );
  const id = assertScope(s);
  const c = await getDocFromServer(doc(f.db, 'communities', id));
  const community = parseCommunity(id, c.data() || {});
  if (s.role === 'resident') {
    assertResident(profile, community);
    if (profile.flatId !== s.profile.flatId)
      throw Error('Your unit assignment changed. Sign in again.');
  }
  if (s.role === 'admin' && !profile.authorizedCommunityIds.includes(id))
    throw Error('Community access revoked.');
  return { ...s, profile, community };
}
function required(v: string, label: string) {
  if (!v.trim()) throw Error(label + ' is required.');
  return v.trim();
}
function exactINRAmount(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const formatted = value.toFixed(2);
  return /^\d+\.\d{2}$/.test(formatted) && Number(formatted) === value ? formatted : null;
}
function isSafeMinor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function minorAmountText(value: number): string {
  const digits = String(value);
  const whole = digits.length > 2 ? digits.slice(0, -2) : '0';
  const paise = digits.slice(-2).padStart(2, '0');
  return `${whole}.${paise}`;
}
function timestampMillis(value: unknown): number {
  if (value && typeof value === 'object') {
    if ('toMillis' in value && typeof value.toMillis === 'function')
      return (value.toMillis as () => number)();
    if ('seconds' in value && typeof value.seconds === 'number') return value.seconds * 1000;
    if (value instanceof Date) return value.getTime();
  }
  return 0;
}
async function latestV2ProofForBill(s: Session, billId: string): Promise<Data | null> {
  const snapshot = await getDocsFromServer(
    query(
      collection(firebase().db, 'paymentProofsV2'),
      where('communityId', '==', s.community!.id),
      where('residentId', '==', s.uid),
      where('billId', '==', billId),
    ),
  );
  const proofs: Data[] = snapshot.docs.map((proof) => ({ ...(proof.data() as Data), id: proof.id }));
  proofs.sort((a, b) => timestampMillis(b.submittedAt) - timestampMillis(a.submittedAt));
  return proofs[0] ?? null;
}
function validateV2Bill(s: Session, bill: Data, billId: string) {
  if (
    bill.schemaVersion !== 2 ||
    bill.communityId !== s.community!.id ||
    bill.flatId !== s.profile.flatId ||
    bill.residentId !== s.uid ||
    (bill.userId != null && bill.userId !== s.uid) ||
    bill.currency !== 'INR' ||
    !['pending', 'overdue', 'partially_paid'].includes(str(bill.status)) ||
    !isSafeMinor(bill.amountMinor) ||
    bill.amountMinor <= 0 ||
    !isSafeMinor(bill.paidAmountMinor) ||
    !isSafeMinor(bill.creditAppliedMinor) ||
    !isSafeMinor(bill.outstandingAmountMinor) ||
    bill.outstandingAmountMinor > bill.amountMinor ||
    typeof bill.currentRevisionId !== 'string' ||
    !bill.currentRevisionId.trim() ||
    !billId
  )
    throw Error('This V2 bill is unavailable or is not eligible for payment.');
  return bill;
}
function receiptExtension(file: File): string {
  return file.name.split('.').pop()?.toLowerCase() || '';
}
const receiptTypes: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
};
function validatePendingV2Proof(s: Session, billId: string, proof: Data) {
  const paymentId = str(proof.id);
  const receiptPath = str(proof.receiptPath);
  const prefix = `payment_receipts/${s.community!.id}/${billId}/${s.uid}/`;
  const extension = receiptPath.startsWith(prefix)
    ? receiptPath.slice(prefix.length).split('.').pop() || ''
    : '';
  if (
    proof.schemaVersion !== 2 ||
    proof.status !== 'pending' ||
    proof.communityId !== s.community!.id ||
    proof.residentId !== s.uid ||
    proof.userId !== s.uid ||
    proof.billId !== billId ||
    proof.currency !== 'INR' ||
    !paymentId ||
    !isSafeMinor(proof.submittedAmountMinor) ||
    proof.submittedAmountMinor <= 0 ||
    typeof proof.submittedBillRevisionId !== 'string' ||
    !proof.submittedBillRevisionId.trim() ||
    !receiptTypes[extension] ||
    receiptPath !== `${prefix}${paymentId}.${extension}`
  )
    throw Error('The pending V2 payment proof is unavailable or invalid.');
  return { paymentId, receiptPath, extension };
}
function proofAttemptStorageKey(uid: string, billId: string) {
  return `hominode-v2-proof-attempt:${uid}:${billId}`;
}
function stableV2IdempotencyKey(uid: string, billId: string, afterProofId: string | null) {
  const storageKey = proofAttemptStorageKey(uid, billId);
  const stored = localStorage.getItem(storageKey);
  if (stored) {
    try {
      const attempt = JSON.parse(stored) as { key?: unknown; afterProofId?: unknown };
      if (typeof attempt.key === 'string' && attempt.afterProofId === afterProofId)
        return attempt.key;
    } catch {
      // Replace stale or malformed local attempt state with a fresh key.
    }
  }
  const idempotencyKey = crypto.randomUUID();
  localStorage.setItem(storageKey, JSON.stringify({ key: idempotencyKey, afterProofId }));
  return idempotencyKey;
}
async function assertExistingReceiptMatches(
  receiptPath: string,
  paymentId: string,
  billId: string,
  communityId: string,
  residentUid: string,
) {
  const metadata = await getMetadata(ref(firebase().storage, receiptPath));
  const custom = metadata.customMetadata || {};
  const requiredMetadata = { paymentId, billId, communityId, residentUid };
  if (
    metadata.fullPath !== receiptPath ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size <= 0 ||
    metadata.size >= 10 * 1024 * 1024 ||
    !/^image\/(jpeg|jpg|png|heic|heif)$/.test(metadata.contentType || '') ||
    Object.keys(custom).length !== 4 ||
    Object.entries(requiredMetadata).some(([key, value]) => custom[key] !== value)
  )
    throw Error('The reserved receipt exists but its evidence metadata does not match this proof.');
}
async function submitV2Proof(
  s: Session,
  billId: string,
  file: File,
  transactionReference: string,
  bill: Data,
) {
  validateV2Bill(s, bill, billId);
  if (bill.outstandingAmountMinor === 0) throw Error('This bill has no outstanding balance.');
  const reference = transactionReference.trim();
  if (reference.length > 200) throw Error('Reference number must be 200 characters or fewer.');
  const latestProof = await latestV2ProofForBill(s, billId);
  const ext = receiptExtension(file);
  if (!receiptTypes[ext] || file.size <= 0 || file.size >= 10 * 1024 * 1024)
    throw Error('Choose a JPG, PNG, HEIC or HEIF image smaller than 10 MB.');

  if (latestProof?.status === 'pending') {
    const existing = validatePendingV2Proof(s, billId, latestProof);
    try {
      await assertExistingReceiptMatches(
        existing.receiptPath,
        existing.paymentId,
        billId,
        s.community!.id,
        s.uid,
      );
      return latestProof;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code !== 'storage/object-not-found') throw error;
    }
    const metadata = {
      paymentId: existing.paymentId,
      billId,
      communityId: s.community!.id,
      residentUid: s.uid,
    };
    await uploadBytes(ref(firebase().storage, existing.receiptPath), file, {
      contentType: receiptTypes[ext],
      customMetadata: metadata,
    });
    return latestProof;
  }

  const idempotencyKey = stableV2IdempotencyKey(
    s.uid,
    billId,
    latestProof && ['failed', 'completed'].includes(str(latestProof.status))
      ? str(latestProof.id)
      : null,
  );
  const payload = {
    billId,
    submittedAmountMinor: bill.outstandingAmountMinor,
    submittedBillRevisionId: bill.currentRevisionId,
    idempotencyKey,
    receiptExtension: ext,
    paymentReference: reference || null,
  };
  const prepared = await call<{
    paymentId: string;
    receiptPath: string;
    status: string;
  }>('preparePaymentProofV2', payload);
  const prefix = `payment_receipts/${s.community!.id}/${billId}/${s.uid}/`;
  if (
    !str(prepared.paymentId) ||
    prepared.status !== 'pending' ||
    prepared.receiptPath !== `${prefix}${prepared.paymentId}.${ext}`
  )
    throw Error('The payment proof could not be prepared safely.');
  await uploadBytes(ref(firebase().storage, prepared.receiptPath), file, {
    contentType: receiptTypes[ext],
    customMetadata: {
      paymentId: prepared.paymentId,
      billId,
      communityId: s.community!.id,
      residentUid: s.uid,
    },
  });
  localStorage.removeItem(proofAttemptStorageKey(s.uid, billId));
  return {
    schemaVersion: 2,
    id: prepared.paymentId,
    communityId: s.community!.id,
    residentId: s.uid,
    userId: s.uid,
    billId,
    status: 'pending',
    submittedAmountMinor: payload.submittedAmountMinor,
    submittedBillRevisionId: payload.submittedBillRevisionId,
    receiptPath: prepared.receiptPath,
    paymentReference: payload.paymentReference,
  };
}
async function prepareV2DirectUpiPayment(s: Session, billId: string, bill: Data) {
  validateV2Bill(s, bill, billId);
  if (bill.outstandingAmountMinor === 0) throw Error('This bill has no outstanding balance.');
  const latestProof = await latestV2ProofForBill(s, billId);
  if (latestProof?.status === 'pending')
    throw Error('A payment proof for this bill is already awaiting administrator review.');

  const configSnapshot = await getDocFromServer(
    doc(firebase().db, 'communityPaymentConfigs', s.community!.id),
  );
  const config = configSnapshot.data();
  const directUpi = config?.directUpi;
  if (
    !config ||
    config.communityId !== s.community!.id ||
    config.version !== 1 ||
    typeof directUpi !== 'object' ||
    directUpi === null ||
    Array.isArray(directUpi) ||
    !('enabled' in directUpi) ||
    directUpi.enabled !== true
  )
    throw Error('Direct UPI is not configured for this community.');
  const payeeName = str('payeeName' in directUpi ? directUpi.payeeName : undefined);
  const vpa = str('vpa' in directUpi ? directUpi.vpa : undefined);
  if (!payeeName || !vpa || !/^[^\s@]+@[^\s@]+$/.test(vpa))
    throw Error('Community Direct UPI details are invalid.');
  const amountMinor = bill.outstandingAmountMinor as number;
  const params = new URLSearchParams({
    pa: vpa,
    pn: payeeName,
    am: minorAmountText(amountMinor),
    cu: 'INR',
  });
  return {
    billId,
    amount: amountMinor / 100,
    amountMinor,
    outstandingAmountMinor: amountMinor,
    currentRevisionId: bill.currentRevisionId as string,
    schemaVersion: 2 as const,
    vpa,
    payeeName,
    paymentUri: `upi://pay?${params.toString()}`,
  };
}
export async function createComplaint(session: Session, values: Record<string, string>) {
  const s = await currentAuthority(session);
  if (s.role !== 'resident') throw Error('A resident account is required.');
  const p = s.profile;
  return addDoc(collection(firebase().db, 'complaints'), {
    userId: s.uid,
    residentId: s.uid,
    userName: p.name,
    userEmail: str(p.data.email),
    flatId: p.flatId,
    flatLabel: p.flatLabel,
    adminId: p.data.adminId ?? null,
    communityId: s.community.id,
    title: required(values.title, 'Title'),
    description: required(values.description, 'Description'),
    category: required(values.category, 'Category').toLowerCase(),
    status: 'pending',
    assignedTo: null,
    technicianPhone: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}
export async function createVisitor(session: Session, v: Record<string, string>) {
  const s = await currentAuthority(session);
  if (s.role !== 'resident') throw Error('A resident account is required.');
  const p = s.profile;
  const arrival = new Date(v.expectedArrival);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (!Number.isFinite(arrival.getTime()) || arrival < today)
    throw Error('Choose a valid arrival date from today onwards.');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const pass = Array.from(bytes, (x) => alphabet[x % 32]).join('');
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return addDoc(collection(firebase().db, 'visitors'), {
    hostUserId: s.uid,
    hostName: p.name,
    hostEmail: str(p.data.email),
    flatId: p.flatId,
    flatLabel: p.flatLabel,
    adminId: p.data.adminId ?? null,
    communityId: s.community.id,
    visitorName: required(v.visitorName, 'Visitor name'),
    purpose: required(v.purpose, 'Purpose'),
    expectedArrival: Timestamp.fromDate(arrival),
    phoneNumber: v.phoneNumber?.trim() || null,
    vehicleNumber: v.vehicleNumber?.trim() || null,
    visitorPassCode: pass.slice(0, 4) + '-' + pass.slice(4),
    qrToken: token,
    status: 'expected',
    isApproved: false,
    approvedBy: null,
    approvedAt: null,
    actualArrival: null,
    departure: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}
export async function updateScoped(
  session: Session,
  collectionName: 'complaints' | 'visitors' | 'notices' | 'notifications',
  id: string,
  fields: Data,
) {
  const s = await currentAuthority(session);
  const record = doc(firebase().db, collectionName, id);
  const data = (await getDocFromServer(record)).data();
  if (data?.communityId !== s.community.id) throw Error('Record is outside your community.');
  if (collectionName === 'notifications') {
    if (data.recipientId !== s.uid) throw Error('Notification access denied.');
    await updateDoc(record, {
      isRead: true,
      readAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return;
  }
  if (s.role !== 'admin') throw Error('An administrator is required.');
  await updateDoc(record, { ...fields, updatedAt: serverTimestamp() });
}
export async function publishNotice(session: Session, v: Record<string, string>) {
  const s = await currentAuthority(session);
  if (s.role !== 'admin') throw Error('An administrator is required.');
  await addDoc(collection(firebase().db, 'notices'), {
    communityId: s.community.id,
    title: required(v.title, 'Title'),
    content: required(v.content, 'Content'),
    targetFlats: [],
    isActive: true,
    status: 'published',
    adminId: s.uid,
    authorId: s.uid,
    authorName: s.profile.name,
    createdAt: serverTimestamp(),
    publishedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}
export async function residentLifecycle(
  session: Session,
  userId: string,
  action: 'deactivateResident' | 'reactivateResident' | 'rejectResidentRegistration',
  reason?: string,
) {
  const s = await currentAuthority(session);
  if (s.role !== 'admin') throw Error('An administrator is required.');
  return call(action, { communityId: s.community.id, userId, ...(reason ? { reason } : {}) });
}
export async function prepareDirectUpiPayment(
  session: Session,
  billId: string,
): Promise<DirectUpiPaymentPreparation> {
  const s = await currentAuthority(session);
  if (s.role !== 'resident') throw Error('A resident account is required.');
  if (!billId.trim() || billId !== billId.trim() || billId.includes('/'))
    throw Error('This bill is not eligible for UPI payment.');

  const billSnapshot = await getDocFromServer(doc(firebase().db, 'bills', billId));
  const bill = billSnapshot.data();
  if (bill?.schemaVersion === 2) return prepareV2DirectUpiPayment(s, billId, bill);
  if (
    !bill ||
    bill.communityId !== s.community.id ||
    bill.flatId !== s.profile.flatId ||
    (bill.residentId != null && bill.residentId !== s.uid) ||
    (bill.userId != null && bill.userId !== s.uid) ||
    !['pending', 'overdue'].includes(str(bill.status)) ||
    bill.paymentId != null ||
    bill.paidAt != null ||
    (bill.paidAmount != null && bill.paidAmount !== 0)
  )
    throw Error('This bill is not eligible for UPI payment.');

  const amount = bill.amount;
  const formattedAmount = exactINRAmount(amount);
  if (formattedAmount === null)
    throw Error('This bill amount cannot be represented in INR currency.');

  const existingProofs = await getDocsFromServer(
    query(
      collection(firebase().db, 'payments'),
      where('communityId', '==', s.community.id),
      where('flatId', '==', s.profile.flatId),
      where('billId', '==', billId),
      where('userId', '==', s.uid),
    ),
  );
  if (
    existingProofs.docs.some((proof) => {
      const data = proof.data();
      return (
        data.communityId === s.community.id &&
        data.flatId === s.profile.flatId &&
        data.billId === billId &&
        data.userId === s.uid &&
        data.status === 'pending'
      );
    })
  )
    throw Error('A payment proof for this bill is already awaiting administrator review.');

  const configSnapshot = await getDocFromServer(
    doc(firebase().db, 'communityPaymentConfigs', s.community.id),
  );
  const config = configSnapshot.data();
  const directUpi = config?.directUpi;
  if (
    !config ||
    config.communityId !== s.community.id ||
    config.version !== 1 ||
    typeof directUpi !== 'object' ||
    directUpi === null ||
    Array.isArray(directUpi) ||
    !('enabled' in directUpi) ||
    directUpi.enabled !== true
  )
    throw Error('Direct UPI is not configured for this community.');

  const payeeName = str('payeeName' in directUpi ? directUpi.payeeName : undefined);
  const vpa = str('vpa' in directUpi ? directUpi.vpa : undefined);
  if (!payeeName || !vpa || !/^[^\s@]+@[^\s@]+$/.test(vpa))
    throw Error('Community Direct UPI details are invalid.');

  const params = new URLSearchParams({
    pa: vpa,
    pn: payeeName,
    am: formattedAmount,
    cu: 'INR',
  });
  return {
    billId,
    amount,
    vpa,
    payeeName,
    paymentUri: `upi://pay?${params.toString()}`,
  };
}

export async function submitProof(
  session: Session,
  billId: string,
  file: File,
  transactionReference = '',
) {
  const s = await currentAuthority(session);
  if (s.role !== 'resident') throw Error('A resident account is required.');
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const types: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    heic: 'image/heic',
    heif: 'image/heif',
  };
  if (!types[ext] || file.size <= 0 || file.size >= 10 * 1024 * 1024)
    throw Error('Choose a JPG, PNG, HEIC or HEIF image smaller than 10 MB.');
  const bill = (await getDocFromServer(doc(firebase().db, 'bills', billId))).data();
  if (bill?.schemaVersion === 2) return submitV2Proof(s, billId, file, transactionReference, bill);
  if (
    !bill ||
    bill.communityId !== s.community.id ||
    bill.flatId !== s.profile.flatId ||
    !['pending', 'overdue'].includes(str(bill.status)) ||
    (bill.residentId != null && bill.residentId !== s.uid) ||
    (bill.userId != null && bill.userId !== s.uid) ||
    bill.paymentId != null ||
    bill.paidAt != null ||
    (bill.paidAmount != null && bill.paidAmount !== 0) ||
    exactINRAmount(bill.amount) === null
  )
    throw Error('This bill is not eligible for payment proof.');
  const reference = transactionReference.trim();
  if (reference.length > 200) throw Error('Reference number must be 200 characters or fewer.');
  const existing = await getDocsFromServer(
    query(
      collection(firebase().db, 'payments'),
      where('communityId', '==', s.community.id),
      where('flatId', '==', s.profile.flatId),
      where('billId', '==', billId),
      where('userId', '==', s.uid),
    ),
  );
  if (
    existing.docs.some((d) => {
      const data = d.data();
      return (
        data.communityId === s.community.id &&
        data.flatId === s.profile.flatId &&
        data.billId === billId &&
        data.userId === s.uid &&
        data.status === 'pending'
      );
    })
  )
    throw Error('A proof is already pending review.');
  const payment = doc(collection(firebase().db, 'payments'));
  const path = `payment_receipts/${s.community.id}/${billId}/${s.uid}/${payment.id}.${ext}`;
  await uploadBytes(ref(firebase().storage, path), file, {
    contentType: types[ext],
    customMetadata: {
      paymentId: payment.id,
      billId,
      communityId: s.community.id,
      residentUid: s.uid,
    },
  });
  try {
    await setDoc(payment, {
      id: payment.id,
      communityId: s.community.id,
      billId,
      flatId: s.profile.flatId,
      userId: s.uid,
      amount: bill.amount,
      provider: 'direct_upi',
      method: 'upi',
      verificationMode: 'manual',
      evidenceType: 'receipt',
      status: 'pending',
      transactionId: reference || null,
      receiptPath: path,
      paymentDate: Timestamp.now(),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
  } catch {
    throw Error(
      'The receipt uploaded, but the payment submission failed. Contact management with reference ' +
        payment.id +
        ' before retrying.',
    );
  }
}
export async function latestPaymentForBill(
  session: Session,
  billId: string,
  bill?: Data,
): Promise<Data | null> {
  console.log('[BillingPaymentStatus] starting', { billId });

  const s = await currentAuthority(session);

  const billData =
    bill ?? (await getDocFromServer(doc(firebase().db, 'bills', billId))).data() ?? {};
  if (billData.schemaVersion === 2) return latestV2ProofForBill(s, billId);

  console.log('[BillingPaymentStatus] authority', {
    uid: s.uid,
    communityId: s.community.id,
    flatId: s.profile.flatId,
  });

  const snapshot = await getDocsFromServer(
    query(
      collection(firebase().db, 'payments'),
      where('communityId', '==', s.community.id),
      where('flatId', '==', s.profile.flatId),
      where('billId', '==', billId),
      where('userId', '==', s.uid),
    ),
  );

  console.log('[BillingPaymentStatus] results:', snapshot.size);

  // keep the rest of your existing function unchanged
  if (snapshot.empty) return null;
  const payments = snapshot.docs.map((d) => d.data());
  payments.sort((a, b) => b.createdAt.seconds - a.createdAt.seconds);
  return payments[0] ?? null;
}

export async function receiptBlob(session: Session, path: string) {
  const s = await currentAuthority(session);
  if (!path.startsWith('payment_receipts/' + s.community.id + '/'))
    throw Error('Receipt is outside your community.');
  return getBlob(ref(firebase().storage, path), 10 * 1024 * 1024);
}
