import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { latestPaymentForBill, prepareDirectUpiPayment, submitProof } from '../actions';
import { Modal } from '../components';
import { str, type Data, type Session } from '../models';

export function ResidentBillPayment({
  session,
  billId,
  bill,
  latestPayment,
  loading,
  onPaymentUpdated,
}: {
  session: Session;
  billId: string;
  bill: Data;
  latestPayment: Data | null;
  loading: boolean;
  onPaymentUpdated: (payment: Data | null) => void;
}) {
  const [preparation, setPreparation] = useState<Awaited<
    ReturnType<typeof prepareDirectUpiPayment>
  > | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const [proofOpen, setProofOpen] = useState(str(latestPayment?.status) === 'failed');
  const [file, setFile] = useState<File | null>(null);
  const [reference, setReference] = useState('');
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const billStatus = str(bill.status).toLowerCase();
  const paymentStatus = str(latestPayment?.status).toLowerCase();
  const eligible = ['pending', 'overdue'].includes(billStatus);
  const settled =
    ['paid', 'completed', 'settled'].includes(billStatus) || paymentStatus === 'completed';
  const pending = paymentStatus === 'pending';

  async function prepare() {
    setPreparing(true);
    setMessage('');
    try {
      setPreparation(await prepareDirectUpiPayment(session, billId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'UPI payment could not be prepared.');
    } finally {
      setPreparing(false);
    }
  }

  async function copyVpa() {
    try {
      await navigator.clipboard.writeText(preparation?.vpa ?? '');
      setCopyMessage('UPI ID copied.');
    } catch {
      setCopyMessage('Could not copy. You can select the UPI ID above.');
    }
  }

  async function submit() {
    if (!file || uploading) return;
    setUploading(true);
    setMessage('');
    try {
      await submitProof(session, billId, file, reference);
      setFile(null);
      setReference('');
      setProofOpen(false);
      onPaymentUpdated(await latestPaymentForBill(session, billId));
      setMessage('Payment proof submitted. Waiting for management review.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Payment proof could not be submitted.');
    } finally {
      setUploading(false);
    }
  }

  if (loading)
    return (
      <div className="payment-proof-status">
        <p>Checking payment proof status…</p>
      </div>
    );

  return (
    <section className="resident-bill-payment" aria-label="Bill payment">
      <div className="payment-proof-status">
        {latestPayment && (
          <>
            <p>
              <strong>Payment proof: </strong>
              {paymentStatus === 'failed'
                ? 'Rejected'
                : paymentStatus === 'pending'
                  ? 'Pending review'
                  : str(latestPayment.status)}
            </p>
            {paymentStatus === 'failed' && str(latestPayment.rejectionReason) && (
              <p>
                <strong>Rejection reason: </strong>
                {str(latestPayment.rejectionReason)}
              </p>
            )}
            {pending && <p>Your payment proof is awaiting administrator review.</p>}
          </>
        )}
        {settled && <p>This bill is marked as paid. No payment action is available.</p>}
      </div>

      {eligible && !settled && !pending && (
        <div className="resident-bill-payment-actions">
          {!proofOpen && (
            <>
              {paymentStatus !== 'failed' && (
                <button
                  type="button"
                  className="primary"
                  disabled={preparing}
                  onClick={() => void prepare()}
                >
                  {preparing ? 'Preparing UPI payment…' : 'Pay via UPI'}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setProofOpen(true);
                  setMessage('');
                }}
              >
                {paymentStatus === 'failed'
                  ? 'Resubmit payment proof'
                  : 'Already paid? Submit payment proof'}
              </button>
            </>
          )}

          {proofOpen && (
            <div className="payment-proof-submit">
              {paymentStatus === 'failed' && <h3>Submit new payment proof</h3>}
              <label>
                Payment receipt image
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/heic,image/heif"
                  disabled={uploading}
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    setMessage('');
                  }}
                />
              </label>
              <label>
                Transaction / Reference No. <span className="optional-label">(optional)</span>
                <input
                  type="text"
                  value={reference}
                  maxLength={200}
                  disabled={uploading}
                  onChange={(event) => setReference(event.target.value)}
                  placeholder="Enter the UPI reference number"
                />
              </label>
              {file && (
                <div className="selected-payment-proof">
                  <strong>Selected file</strong>
                  <span>{file.name}</span>
                  <small>{(file.size / 1024 / 1024).toFixed(2)} MB</small>
                </div>
              )}
              <div className="resident-bill-payment-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={!file || uploading}
                  onClick={() => void submit()}
                >
                  {uploading
                    ? 'Uploading payment proof…'
                    : paymentStatus === 'failed'
                      ? 'Resubmit payment proof'
                      : 'Submit payment proof'}
                </button>
                {paymentStatus !== 'failed' && (
                  <button type="button" disabled={uploading} onClick={() => setProofOpen(false)}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {message && (
        <p className="payment-message" role="status">
          {message}
        </p>
      )}

      {preparation && (
        <Modal
          title="Pay via UPI"
          onClose={() => {
            setPreparation(null);
            setCopyMessage('');
          }}
        >
          <div className="direct-upi-modal">
            <p>Scan using any UPI app on your phone.</p>
            <div className="direct-upi-qr">
              <QRCodeSVG value={preparation.paymentUri} size={220} level="M" includeMargin />
            </div>
            <dl>
              <div>
                <dt>Payee</dt>
                <dd>{preparation.payeeName}</dd>
              </div>
              <div>
                <dt>UPI ID</dt>
                <dd>{preparation.vpa}</dd>
              </div>
              <div>
                <dt>Bill amount</dt>
                <dd>₹{preparation.amount.toFixed(2)}</dd>
              </div>
            </dl>
            <p className="direct-upi-note">
              This QR code prepares your payment. Your bill will remain unpaid until management
              reviews your payment proof.
            </p>
            <div className="resident-bill-payment-actions">
              <button type="button" onClick={() => void copyVpa()}>
                Copy UPI ID
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setPreparation(null);
                  setProofOpen(true);
                  setCopyMessage('');
                }}
              >
                I have paid – submit payment proof
              </button>
              <button
                type="button"
                onClick={() => {
                  setPreparation(null);
                  setCopyMessage('');
                }}
              >
                Close
              </button>
            </div>
            {copyMessage && <p role="status">{copyMessage}</p>}
          </div>
        </Modal>
      )}
    </section>
  );
}
