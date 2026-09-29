import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { latestPaymentForBill, prepareDirectUpiPayment, submitProof } from '../actions';
import { Modal } from '../components';
import {
  dateLabel,
  formatInrMinorUnits,
  isValidV2InrBill,
  isV2Bill,
  paymentAttributionLabel,
  paymentMethodLabel,
  str,
  type Data,
  type Session,
} from '../models';

function isBillSettled(bill: Data) {
  const billStatus = str(bill.status).toLowerCase();
  if (isV2Bill(bill)) return ['paid', 'settled'].includes(billStatus);
  return (
    ['paid', 'completed', 'settled'].includes(billStatus) ||
    bill.paymentId != null ||
    bill.paidAt != null ||
    (typeof bill.paidAmount === 'number' && bill.paidAmount !== 0)
  );
}

function V2BillSummary({ bill }: { bill: Data }) {
  const rows: [string, unknown][] = [
    ['Total', bill.amountMinor],
    ['Paid', bill.paidAmountMinor],
    ['Credit applied', bill.creditAppliedMinor],
    ['Outstanding', bill.outstandingAmountMinor],
  ];
  const lines = Array.isArray(bill.chargeLines) ? bill.chargeLines : [];
  return (
    <dl className="detail-fields payment-settlement-summary" aria-label="V2 bill breakdown">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{formatInrMinorUnits(value)}</dd>
        </div>
      ))}
      {lines.length > 0 && (
        <div>
          <dt>Charge details</dt>
          <dd>
            <ul>
              {lines.map((line, index) => {
                const charge =
                  line && typeof line === 'object' ? (line as Record<string, unknown>) : {};
                return (
                  <li key={typeof charge.lineId === 'string' ? charge.lineId : index}>
                    {str(charge.label) || 'Charge'}: {formatInrMinorUnits(charge.amountMinor)}
                  </li>
                );
              })}
            </ul>
          </dd>
        </div>
      )}
    </dl>
  );
}

function PaidBillSummary({ bill }: { bill: Data }) {
  const method = paymentMethodLabel(bill.paymentMethod);
  const reference = str(bill.paymentReference) || str(bill.transactionId);
  const attribution = paymentAttributionLabel(bill.paymentMethod);
  return (
    <dl className="detail-fields payment-settlement-summary" aria-label="Payment settlement">
      <div>
        <dt>Payment status</dt>
        <dd>Paid</dd>
      </div>
      {method !== '—' && (
        <div>
          <dt>Paid via</dt>
          <dd>{method}</dd>
        </div>
      )}
      {reference && (
        <div>
          <dt>Payment reference</dt>
          <dd>{reference}</dd>
        </div>
      )}
      {bill.paidAt != null && (
        <div>
          <dt>Paid on</dt>
          <dd>{dateLabel(bill.paidAt)}</dd>
        </div>
      )}
      {attribution && (
        <div>
          <dt>Settlement</dt>
          <dd>{attribution}</dd>
        </div>
      )}
    </dl>
  );
}

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
  const [cashDetailsOpen, setCashDetailsOpen] = useState(false);
  const billStatus = str(bill.status).toLowerCase();
  const paymentStatus = str(latestPayment?.status).toLowerCase();
  const isV2 = isV2Bill(bill);
  const validV2 = !isV2 || isValidV2InrBill(bill);
  const outstanding = isV2 && validV2 ? (bill.outstandingAmountMinor as number) : 0;
  const eligible = isV2
    ? validV2 && ['pending', 'overdue', 'partially_paid'].includes(billStatus) && outstanding > 0
    : ['pending', 'overdue'].includes(billStatus);
  const settled = isV2
    ? isBillSettled(bill) || (validV2 && outstanding === 0)
    : isBillSettled(bill);
  const pending = paymentStatus === 'pending';
  const latestPaymentMethod = latestPayment
    ? str(latestPayment.method).toLowerCase() === 'upi' &&
      str(latestPayment.provider).toLowerCase() === 'direct_upi'
      ? 'UPI / Direct UPI'
      : str(latestPayment.method).toLowerCase() === 'external'
        ? 'External'
        : paymentMethodLabel(latestPayment.method ?? latestPayment.paymentMethod)
    : '';

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
      onPaymentUpdated(await latestPaymentForBill(session, billId, bill));
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
        <p>Checking payment status…</p>
      </div>
    );

  if (isV2 && !validV2)
    return (
      <section className="resident-bill-payment" aria-label="Bill payment">
        <div className="payment-proof-status" role="status">
          <p>
            Billing details unavailable. Payment is disabled until INR bill details can be verified.
          </p>
        </div>
      </section>
    );

  return (
    <section className="resident-bill-payment" aria-label="Bill payment">
      {isV2 && <V2BillSummary bill={bill} />}
      {settled ? (
        isV2 ? (
          <div className="payment-proof-status" role="status">
            <p>
              {outstanding === 0
                ? 'Bill settled.'
                : paymentStatus === 'completed'
                  ? 'Payment proof completed.'
                  : 'Bill settled.'}
            </p>
          </div>
        ) : (
          <PaidBillSummary bill={bill} />
        )
      ) : (
        <>
          {latestPayment && (
            <div className="payment-proof-status">
              <p>
                <strong>Payment method: </strong>
                {latestPaymentMethod}
              </p>
              <p>
                <strong>Payment proof: </strong>
                {paymentStatus === 'failed'
                  ? 'Rejected'
                  : paymentStatus === 'pending'
                    ? 'Pending review'
                    : paymentStatus === 'completed'
                      ? 'Completed'
                      : str(latestPayment.status)}
              </p>
              {paymentStatus === 'failed' && str(latestPayment.rejectionReason) && (
                <p>
                  <strong>Rejection reason: </strong>
                  {str(latestPayment.rejectionReason)}
                </p>
              )}
              {pending && <p>Admin verification is pending.</p>}
              {isV2 && paymentStatus === 'completed' && outstanding > 0 && (
                <p>This payment is complete. The bill still has an outstanding balance.</p>
              )}
            </div>
          )}

          {eligible && (
            <div className="resident-payment-choices">
              <article className="resident-payment-choice">
                <h3>Direct UPI</h3>
                <p>
                  {isV2
                    ? 'Pay the exact outstanding amount using the community’s verified UPI details.'
                    : 'Pay the exact bill amount using the community’s verified UPI details.'}
                </p>
                {isV2 && pending && !proofOpen && (
                  <button type="button" onClick={() => setProofOpen(true)}>
                    Resume receipt upload
                  </button>
                )}
                {!pending && !proofOpen && (
                  <div className="resident-bill-payment-actions">
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
                        : isV2 && paymentStatus === 'completed'
                          ? 'Submit proof for remaining balance'
                          : 'Already paid? Submit payment proof'}
                    </button>
                  </div>
                )}
                {proofOpen && (
                  <div className="payment-proof-submit">
                    {paymentStatus === 'failed' && <h4>Submit new UPI payment proof</h4>}
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
                        <button
                          type="button"
                          disabled={uploading}
                          onClick={() => setProofOpen(false)}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </article>

              <article className="resident-payment-choice cash-payment-choice">
                <h3>Cash</h3>
                <p>Pay cash directly to your community office.</p>
                <p>
                  Your bill will be marked paid only after the Admin receives and records the
                  payment.
                </p>
                <button type="button" onClick={() => setCashDetailsOpen((open) => !open)}>
                  {cashDetailsOpen ? 'Hide Cash payment details' : 'How Cash payments work'}
                </button>
                {cashDetailsOpen && (
                  <p role="status">
                    Cash payment is confirmed by your Admin. No receipt upload or online settlement
                    is needed here.
                  </p>
                )}
              </article>
            </div>
          )}
        </>
      )}

      {message && (
        <p className="payment-message" role="status">
          {message}
        </p>
      )}

      {isV2 && validV2 && !eligible && !settled && outstanding === 0 && (
        <p className="payment-proof-status" role="status">
          No outstanding balance. No payment is due.
        </p>
      )}

      {preparation && !settled && (
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
                <dt>{preparation.schemaVersion === 2 ? 'Outstanding amount' : 'Bill amount'}</dt>
                <dd>
                  {preparation.schemaVersion === 2
                    ? formatInrMinorUnits(preparation.outstandingAmountMinor)
                    : `₹${preparation.amount.toFixed(2)}`}
                </dd>
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
