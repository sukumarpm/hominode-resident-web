import { useEffect, useRef, useState } from 'react';
import { useAuth } from './session';
import {
  getResidentBillingV2Statement,
  RESIDENT_BILLING_STATEMENT_ERROR,
  type ResidentBillingStatement,
  type ResidentBillingStatementBill,
  type ResidentBillingStatementSummary,
  type ResidentStatementSettlement,
} from './residentBillingStatement';
import { formatInrMinorUnits, type Session } from './models';
import {
  getResidentBillingV2Receipt,
  RESIDENT_BILLING_V2_RECEIPT_ERROR,
  type ResidentBillingV2Receipt,
} from './residentBillingV2Receipt';

type StatementLoader = (
  session: Session,
  billingPeriod: string,
) => Promise<ResidentBillingStatement>;
type ReceiptLoader = (session: Session, transactionId: string) => Promise<ResidentBillingV2Receipt>;

export function ResidentBillingStatementPage({
  loadStatement = getResidentBillingV2Statement,
  loadReceipt = getResidentBillingV2Receipt,
  now = () => new Date(),
}: {
  loadStatement?: StatementLoader;
  loadReceipt?: ReceiptLoader;
  now?: () => Date;
}) {
  const { session } = useAuth();
  const [selectedMonth, setSelectedMonth] = useState(() => monthStart(now()));
  const [statement, setStatement] = useState<ResidentBillingStatement | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [receiptTransactionId, setReceiptTransactionId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ResidentBillingV2Receipt | null>(null);
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [receiptFailed, setReceiptFailed] = useState(false);
  const requestId = useRef(0);
  const receiptRequestId = useRef(0);
  const billingPeriod = monthKey(selectedMonth);

  useEffect(() => {
    receiptRequestId.current += 1;
    setReceiptTransactionId(null);
    setReceipt(null);
    setReceiptLoading(false);
    setReceiptFailed(false);
    return () => {
      receiptRequestId.current += 1;
    };
  }, [session]);

  async function openReceipt(transactionId: string) {
    if (!session || receiptLoading) return;
    const generation = ++receiptRequestId.current;
    setReceiptTransactionId(transactionId);
    setReceipt(null);
    setReceiptFailed(false);
    setReceiptLoading(true);
    try {
      const value = await loadReceipt(session, transactionId);
      if (generation === receiptRequestId.current) setReceipt(value);
    } catch {
      if (generation === receiptRequestId.current) setReceiptFailed(true);
    } finally {
      if (generation === receiptRequestId.current) setReceiptLoading(false);
    }
  }

  function retryReceipt() {
    if (receiptTransactionId) void openReceipt(receiptTransactionId);
  }

  useEffect(() => {
    const generation = ++requestId.current;
    let active = true;
    setStatement(null);
    setFailed(false);
    if (!session || session.role !== 'resident' || session.profile.role !== 'resident') {
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);
    void loadStatement(session, billingPeriod)
      .then((result) => {
        if (active && generation === requestId.current) {
          setStatement(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active && generation === requestId.current) {
          setStatement(null);
          setFailed(true);
          setLoading(false);
        }
      });
    return () => {
      active = false;
      requestId.current += 1;
    };
  }, [session, billingPeriod, retry, loadStatement]);

  function changeMonth(offset: number) {
    receiptRequestId.current += 1;
    setReceiptTransactionId(null);
    setReceipt(null);
    setReceiptLoading(false);
    setReceiptFailed(false);
    setStatement(null);
    setFailed(false);
    setLoading(true);
    setSelectedMonth((month) => new Date(month.getFullYear(), month.getMonth() + offset, 1));
  }

  const hasResidentSession =
    !!session && session.role === 'resident' && session.profile.role === 'resident';

  return (
    <main className="resident-billing-statement resident-statement-page">
      <header className="resident-statement-header">
        <div>
          <p className="eyebrow">{session?.community?.name || 'Hominode'}</p>
          <h1>Monthly Statement</h1>
          <p>Billing and payment activity for your account.</p>
        </div>
      </header>

      <section className="resident-statement-period" aria-label="Statement month selector">
        <button type="button" aria-label="Previous month" onClick={() => changeMonth(-1)}>
          Previous
        </button>
        <h2 aria-live="polite">{monthLabel(selectedMonth)}</h2>
        <button type="button" aria-label="Next month" onClick={() => changeMonth(1)}>
          Next
        </button>
      </section>

      {!hasResidentSession ? (
        <p className="resident-statement-error" role="alert">
          Resident access is required to view this statement.
        </p>
      ) : loading ? (
        <section className="resident-statement-state" role="status">
          <span className="resident-statement-spinner" aria-hidden="true" />
          <span>Loading statement…</span>
        </section>
      ) : failed ? (
        <section className="resident-statement-error" role="alert">
          <h2>Statement unavailable</h2>
          <p>{RESIDENT_BILLING_STATEMENT_ERROR}</p>
          <button
            type="button"
            className="resident-statement-retry"
            onClick={() => {
              setStatement(null);
              setFailed(false);
              setLoading(true);
              setRetry((value) => value + 1);
            }}
          >
            Retry
          </button>
        </section>
      ) : statement ? (
        <>
          <StatementSummary summary={statement.summary} />
          {statement.bills.length === 0 ? (
            <section className="resident-statement-empty" aria-live="polite">
              <h2>No bills for this month</h2>
              <p>There are no bills for the selected billing period.</p>
            </section>
          ) : (
            <div className="resident-statement-bills">
              {statement.bills.map((bill) => (
                <StatementBill
                  key={bill.billId}
                  bill={bill}
                  onViewReceipt={openReceipt}
                  receiptLoading={receiptLoading}
                  loadingTransactionId={receiptTransactionId}
                />
              ))}
            </div>
          )}
          {receiptTransactionId && (
            <ResidentV2ReceiptPanel
              receipt={receipt}
              loading={receiptLoading}
              failed={receiptFailed}
              onRetry={retryReceipt}
            />
          )}
        </>
      ) : null}
    </main>
  );
}

function StatementSummary({ summary }: { summary: ResidentBillingStatementSummary }) {
  return (
    <section className="resident-statement-summary" aria-labelledby="statement-summary-title">
      <h2 id="statement-summary-title" className="resident-statement-section-title">
        Statement Summary
      </h2>
      <div className="resident-statement-kpis">
        <StatementKpi label="Total billed" value={summary.billedMinor} />
        <StatementKpi label="Payments applied" value={summary.paidAllocationMinor} />
        <StatementKpi label="Outstanding" value={summary.outstandingMinor} />
        <StatementKpi
          label="Available credit"
          value={summary.availableCreditMinor}
          note="Account-level current balance"
        />
      </div>
      <div className="resident-statement-secondary">
        <section className="resident-statement-credit-applied" aria-label="Credit applied">
          <span>Credit applied</span>
          <strong>{formatInrMinorUnits(summary.creditAppliedMinor)}</strong>
        </section>
        <section className="resident-statement-status" aria-labelledby="statement-status-title">
          <header>
            <h3 id="statement-status-title">Bill status</h3>
            <span>{summary.billsCount} bills</span>
          </header>
          <dl>
            <CountRow label="Paid" value={summary.statusCounts.paid} />
            <CountRow label="Pending" value={summary.statusCounts.pending} />
            <CountRow label="Partially paid" value={summary.statusCounts.partially_paid} />
            <CountRow label="Overdue" value={summary.statusCounts.overdue} />
          </dl>
        </section>
      </div>
    </section>
  );
}

function StatementKpi({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <article className="resident-statement-kpi">
      <span>{label}</span>
      <strong>{formatInrMinorUnits(value)}</strong>
      {note && <small>{note}</small>}
    </article>
  );
}

function StatementBill({
  bill,
  onViewReceipt,
  receiptLoading,
  loadingTransactionId,
}: {
  bill: ResidentBillingStatementBill;
  onViewReceipt: (transactionId: string) => void;
  receiptLoading: boolean;
  loadingTransactionId: string | null;
}) {
  return (
    <article className="resident-statement-bill">
      <header className="resident-statement-bill-header">
        <div>
          <span>Billing period</span>
          <h2>{monthLabel(parseMonthKey(bill.billingPeriod))}</h2>
        </div>
        <span className={`resident-statement-badge status-${bill.status}`}>
          {titleCase(bill.status)}
        </span>
        <div className="resident-statement-due-date">
          <span>Due date</span>
          <strong>{formatDateKey(bill.dueDateKey)}</strong>
        </div>
      </header>
      <dl className="resident-statement-bill-summary">
        <MoneyRow label="Total" value={bill.amountMinor} />
        <MoneyRow label="Payment allocations" value={bill.paidAllocationMinor} />
        <MoneyRow label="Credit applied" value={bill.creditAppliedMinor} />
        <MoneyRow label="Outstanding" value={bill.outstandingMinor} />
      </dl>

      <section className="resident-statement-charge-lines" aria-label="Charge breakdown">
        <h3>Charge breakdown</h3>
        <dl>
          {bill.chargeLines.map((line) => (
            <MoneyRow key={line.lineId} label={line.label} value={line.amountMinor} />
          ))}
        </dl>
      </section>

      <section className="resident-statement-settlements" aria-label="Settlements">
        <h3>Settlements</h3>
        {bill.settlements.length === 0 ? (
          <p className="resident-statement-settlement-empty">
            No payments applied to this bill yet.
          </p>
        ) : (
          <div>
            {bill.settlements.map((settlement) => (
              <Settlement
                key={settlement.transactionId}
                settlement={settlement}
                onViewReceipt={onViewReceipt}
                receiptLoading={receiptLoading}
                isLoading={loadingTransactionId === settlement.transactionId}
              />
            ))}
          </div>
        )}
      </section>
    </article>
  );
}

function Settlement({
  settlement,
  onViewReceipt,
  receiptLoading,
  isLoading,
}: {
  settlement: ResidentStatementSettlement;
  onViewReceipt: (transactionId: string) => void;
  receiptLoading: boolean;
  isLoading: boolean;
}) {
  return (
    <dl className="resident-statement-settlement">
      <MoneyRow label={methodLabel(settlement.method)} value={settlement.netAppliedMinor} />
      <div>
        <dt>Received</dt>
        <dd>{formatDate(new Date(settlement.receivedAt))}</dd>
      </div>
      {settlement.reference !== null && (
        <div>
          <dt>Payment reference</dt>
          <dd>{settlement.reference}</dd>
        </div>
      )}
      <div>
        <dt>Official receipt</dt>
        <dd>
          <button
            type="button"
            className="resident-statement-receipt-link"
            disabled={receiptLoading}
            aria-label={`View receipt for payment ${settlement.reference || formatDate(new Date(settlement.receivedAt))}`}
            onClick={() => onViewReceipt(settlement.transactionId)}
          >
            {isLoading ? 'Loading…' : 'View Receipt'}
          </button>
        </dd>
      </div>
    </dl>
  );
}

function ResidentV2ReceiptPanel({
  receipt,
  loading,
  failed,
  onRetry,
}: {
  receipt: ResidentBillingV2Receipt | null;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <section className="resident-v2-receipt" aria-labelledby="resident-v2-receipt-title">
      {loading ? (
        <div className="resident-statement-state" role="status">
          <span className="resident-statement-spinner" aria-hidden="true" />
          <span>Loading verified receipt…</span>
        </div>
      ) : failed ? (
        <div className="resident-statement-error" role="alert">
          <h2>Receipt unavailable</h2>
          <p>{RESIDENT_BILLING_V2_RECEIPT_ERROR}</p>
          <button type="button" className="resident-statement-retry" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : receipt ? (
        <article className="resident-v2-receipt-paper">
          <header>
            <div className="resident-v2-receipt-brand">HOMINODE</div>
            <div>
              <span>Official payment receipt</span>
              <h2 id="resident-v2-receipt-title">{receipt.receiptId}</h2>
            </div>
          </header>
          <section className="resident-v2-receipt-community">
            <h3>{receipt.communityName || 'Community'}</h3>
            {receipt.communityAddress && <p>{receipt.communityAddress}</p>}
          </section>
          <dl className="resident-v2-receipt-details">
            <ReceiptRow
              label="Amount received"
              value={formatInrMinorUnits(receipt.moneyReceivedMinor)}
            />
            <ReceiptRow label="Payment date" value={formatDate(new Date(receipt.receivedAt))} />
            <ReceiptRow label="Payment method" value={methodLabel(receipt.method)} />
            <ReceiptRow label="Receipt number" value={receipt.receiptId} />
            {receipt.paymentReference && (
              <ReceiptRow label="Payment reference" value={receipt.paymentReference} />
            )}
            <ReceiptRow label="Verified by" value={receipt.verifiedBy} />
            <ReceiptRow label="Verified date" value={formatDate(new Date(receipt.verifiedAt))} />
          </dl>
          {receipt.claimedAmountMinor !== null && receipt.amountMismatch === true && (
            <p className="resident-v2-receipt-note">
              The resident claim was {formatInrMinorUnits(receipt.claimedAmountMinor)}. This receipt
              shows the amount verified by the Community Admin.
            </p>
          )}
          <section aria-label="This payment allocations" className="resident-v2-receipt-section">
            <h3>Allocations from this payment</h3>
            {receipt.allocations.length ? (
              <dl>
                {receipt.allocations.map((allocation, index) => (
                  <ReceiptRow
                    key={`${receipt.transactionId}-allocation-${index}`}
                    label={`Bill allocation ${index + 1}`}
                    value={formatInrMinorUnits(allocation.amountMinor)}
                  />
                ))}
              </dl>
            ) : (
              <p>No bill allocation was recorded for this payment.</p>
            )}
            <ReceiptRow
              label="Excess credit created"
              value={formatInrMinorUnits(receipt.excessCreditMinor)}
            />
            <p>
              Existing credit applied to bills is not counted as money received on this receipt.
            </p>
          </section>
          {(receipt.reversedAllocationMinor > 0 || receipt.revisionCreditIssuedMinor > 0) && (
            <section className="resident-v2-receipt-section">
              <h3>Later bill revision adjustments</h3>
              <dl>
                <ReceiptRow
                  label="Reversed allocations"
                  value={formatInrMinorUnits(receipt.reversedAllocationMinor)}
                />
                <ReceiptRow
                  label="Revision credit issued"
                  value={formatInrMinorUnits(receipt.revisionCreditIssuedMinor)}
                />
              </dl>
              <p>These later changes do not alter the original amount received.</p>
            </section>
          )}
          <button
            type="button"
            className="resident-v2-receipt-print"
            onClick={() => window.print()}
          >
            Print / Download PDF
          </button>
          <p className="resident-v2-receipt-footer">
            This receipt records the original Admin-verified settlement. No pending or rejected
            proof is an official receipt.
          </p>
        </article>
      ) : null}
    </section>
  );
}

function ReceiptRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function MoneyRow({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{formatInrMinorUnits(value)}</dd>
    </div>
  );
}

function CountRow({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function monthStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function monthKey(date: Date) {
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;
}

function parseMonthKey(value: string) {
  const [year, month] = value.split('-').map(Number);
  return new Date(year, month - 1, 1);
}

function monthLabel(date: Date) {
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date);
}

function formatDateKey(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return formatDate(new Date(year, month - 1, day));
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(value);
}

function methodLabel(method: ResidentStatementSettlement['method']) {
  switch (method) {
    case 'upi':
      return 'UPI';
    case 'cash':
      return 'Cash';
    case 'bank_transfer':
      return 'Bank Transfer';
    case 'cheque':
      return 'Cheque';
  }
}

function titleCase(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (part) => part.toUpperCase());
}
