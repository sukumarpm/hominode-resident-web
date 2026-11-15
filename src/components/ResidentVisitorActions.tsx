import { useEffect, useRef, useState } from 'react';
import type { Row, Session } from '../models';
import { mutateResidentVisitor, ownVisitor } from '../residentVisitorService';
import {
  canChangeVisitor,
  residentVisitorError,
  visitorAuthorization,
  visitorPhysicalState,
} from '../residentVisitor';
import { ResidentVisitorForm } from './ResidentVisitorForm';

export function ResidentVisitorActions({
  session,
  row,
  mutate = mutateResidentVisitor,
  onConfirmed,
}: {
  session: Session;
  row: Row;
  mutate?: typeof mutateResidentVisitor;
  onConfirmed?: () => void;
}) {
  const [confirm, setConfirm] = useState(false),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [blockedRevision, setBlockedRevision] = useState<string | null>(null);
  const revision = JSON.stringify([row.id, row.data.authorizationRevision, row.data.status]);
  const blocked = blockedRevision === revision;
  const locked = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setConfirm(false);
    setEditing(false);
    setBlockedRevision(null);
    setMessage('');
  }, [row.id, row.data.authorizationRevision, row.data.status]);
  if (!ownVisitor(session, row.data))
    return <p role="status">This invitation is not available in your Resident account.</p>;
  async function cancel() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setMessage('');
    try {
      await mutate(session, row, 'cancel');
      if (mounted.current) {
        setMessage('Cancellation confirmed. The invitation remains in History.');
        onConfirmed?.();
        setBlockedRevision(revision);
        setConfirm(false);
      }
    } catch (e) {
      if (mounted.current) {
        setMessage(residentVisitorError(e));
        setConfirm(false);
        setBlockedRevision(revision);
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="resident-visitor-actions" aria-label="Visitor authorization and actions">
      <p>
        <strong>Authorization:</strong> {visitorAuthorization(row.data)}
      </p>
      <p>
        <strong>Visit:</strong> {visitorPhysicalState(row.data)}
      </p>
      <p>
        Pet disclosure:{' '}
        {row.data.bringingPet === true ? 'Visitor will bring a pet' : 'No pet declared'}
      </p>
      {message && <p role="status">{message}</p>}
      {canChangeVisitor(row.data) && !blocked && (
        <div className="button-row">
          <button disabled={busy} onClick={() => setEditing(true)}>
            Reschedule visitor
          </button>
          <button disabled={busy} onClick={() => setConfirm(true)}>
            Cancel invitation
          </button>
        </div>
      )}
      {confirm && (
        <div role="group" aria-label="Confirm visitor cancellation">
          <p>
            Cancel {String(row.data.visitorName || 'this invitation')}? Its pass will no longer be
            usable.
          </p>
          <div className="button-row">
            <button disabled={busy} onClick={() => void cancel()}>
              {busy ? 'Cancelling…' : 'Confirm cancellation'}
            </button>
            <button disabled={busy} onClick={() => setConfirm(false)}>
              Keep invitation
            </button>
          </div>
        </div>
      )}
      {blocked && (
        <p>Use Refresh page data to review the current invitation before another action.</p>
      )}
      {editing && (
        <ResidentVisitorForm
          session={session}
          row={row}
          mutate={mutate}
          onClose={() => setEditing(false)}
          onSaved={() => {
            onConfirmed?.();
            setMessage(
              'Rescheduling confirmed. Authorization and pass availability are being refreshed.',
            );
            setBlockedRevision(revision);
          }}
        />
      )}
    </section>
  );
}
