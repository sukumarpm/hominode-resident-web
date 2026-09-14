import {
  addDoc,
  collection,
  doc,
  getDocFromServer,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { getBlob, ref, uploadBytes } from 'firebase/storage';
import { call, firebase } from './firebase';
import { type Data, type Session, str } from './models';
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
export async function submitProof(session: Session, billId: string, file: File) {
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
  if (
    !bill ||
    bill.communityId !== s.community.id ||
    bill.flatId !== s.profile.flatId ||
    bill.status !== 'pending' ||
    typeof bill.amount !== 'number' ||
    bill.amount <= 0
  )
    throw Error('This bill is not eligible for payment proof.');
  const existing = await getDocs(
    query(
      collection(firebase().db, 'payments'),
      where('communityId', '==', s.community.id),
      where('flatId', '==', s.profile.flatId),
      where('billId', '==', billId),
      where('userId', '==', s.uid),
    ),
  );
  if (existing.docs.some((d) => d.data().status === 'pending'))
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
      method: 'external',
      status: 'pending',
      transactionId: null,
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
): Promise<Data | null> {
  console.log('[BillingPaymentStatus] starting', { billId });

  const s = await currentAuthority(session);

  console.log('[BillingPaymentStatus] authority', {
    uid: s.uid,
    communityId: s.community.id,
    flatId: s.profile.flatId,
  });

  const snapshot = await getDocs(
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
