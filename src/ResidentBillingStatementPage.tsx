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

type StatementLoader = (
  session: Session,
  billingPeriod: string,
) => Promise<ResidentBillingStatement>;

export function ResidentBillingStatementPage({
  loadStatement = getResidentBillingV2Statement,
  now = () => new Date(),
}: {
  loadStatement?: StatementLoader;
  now?: () => Date;
}) {
  const { session } = useAuth();
  const [selectedMonth, setSelectedMonth] = useState(() => monthStart(now()));
  const [statement, setStatement] = useState<ResidentBillingStatement | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const requestId = useRef(0);
  const billingPeriod = monthKey(selectedMonth);

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
                <StatementBill key={bill.billId} bill={bill} />
              ))}
            </div>
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

function StatementKpi({
  label,
  value,
  note,
}: {
  label: string;
  value: number;
  note?: string;
}) {
  return (
    <article className="resident-statement-kpi">
      <span>{label}</span>
      <strong>{formatInrMinorUnits(value)}</strong>
      {note && <small>{note}</small>}
    </article>
  );
}

function StatementBill({ bill }: { bill: ResidentBillingStatementBill }) {
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
          <p className="resident-statement-settlement-empty">No payments applied to this bill yet.</p>
        ) : (
          <div>
            {bill.settlements.map((settlement) => (
              <Settlement key={settlement.transactionId} settlement={settlement} />
            ))}
          </div>
        )}
      </section>
    </article>
  );
}

function Settlement({ settlement }: { settlement: ResidentStatementSettlement }) {
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
    </dl>
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
