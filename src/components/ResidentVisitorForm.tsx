import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Modal } from '../components';
import { PhoneNumberInput } from './PhoneNumberInput';
import { createVisitor } from '../actions';
import type { Row, Session } from '../models';
import { dateOf } from '../models';
import {
  communityZone,
  communityTimeLabel,
  petVisitMessage,
  residentVisitorError,
  visitorArrival,
  visitorLocalTime,
} from '../residentVisitor';
import {
  mutateResidentVisitor,
  visitorContext,
  type InvitationResult,
} from '../residentVisitorService';
import '../residentVisitor.css';

interface Props {
  session: Session;
  row?: Row;
  onClose: () => void;
  onSaved?: (result: InvitationResult) => void;
  create?: typeof createVisitor;
  context?: typeof visitorContext;
  mutate?: typeof mutateResidentVisitor;
}
export function ResidentVisitorForm({
  session,
  row,
  onClose,
  onSaved,
  create = createVisitor,
  context = visitorContext,
  mutate = mutateResidentVisitor,
}: Props) {
  const zone =
    typeof session.community?.data.timeZone === 'string'
      ? session.community.data.timeZone
      : undefined;
  let zoneError = '';
  try { communityZone(zone); } catch (e) { zoneError = (e as Error).message; }
  const [arrival, setArrival] = useState(() => {
    if (!row || zoneError) return '';
    return visitorLocalTime(dateOf(row.data.expectedArrival ?? row.data.expectedTime)?.getTime() ?? Date.now(), zone);
  });
  const [pet, setPet] = useState(row?.data.bringingPet === true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [guidance, setGuidance] = useState<{
    petPermitted: boolean;
    authorizationState: string;
  } | null>(null);
  const [guidanceError, setGuidanceError] = useState('');
  const lock = useRef(false),
    mounted = useRef(true),
    generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const ticket = ++generation.current;
    setGuidance(null);
    setGuidanceError('');
    if (!arrival) return;
    let ms: number;
    try {
      ms = visitorArrival(arrival, zone);
    } catch (e) {
      setGuidanceError(residentVisitorError(e));
      return;
    }
    if (ms <= Date.now()) {
      setGuidanceError('Policy and pet entry will be checked when you submit.');
      return;
    }
    const timer = setTimeout(() => {
      void context(session, ms)
        .then((value) => {
          if (mounted.current && ticket === generation.current) setGuidance(value);
        })
        .catch(() => {
          if (mounted.current && ticket === generation.current)
            setGuidanceError(
              'Guidance could not be loaded. Policy and pet entry will be checked when you submit.',
            );
        });
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [arrival, zone, session, context]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    setError('');
    try {
      if (pet && guidance?.petPermitted === false) throw Error(petVisitMessage);
      lock.current = true;
      setBusy(true);
      const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<
        string,
        string
      >;
      const originalArrival = row
        ? dateOf(row.data.expectedArrival ?? row.data.expectedTime)?.getTime()
        : null;
      const unchangedTime =
        originalArrival != null && arrival === visitorLocalTime(originalArrival, zone);
      const result = row
        ? await mutate(session, row, 'reschedule', {
            ...(unchangedTime ? {} : { expectedArrival: visitorArrival(arrival, zone) }),
            bringingPet: pet,
          })
        : await create(session, { ...values, expectedArrival: arrival }, pet);
      if (mounted.current) {
        onSaved?.(result);
        onClose();
      }
    } catch (e) {
      if (mounted.current) setError(residentVisitorError(e));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={row ? 'Reschedule visitor' : 'Invite a Visitor'}
      onCancel={(event) => {
        if (lock.current) event.preventDefault();
        else onClose();
      }}
      onClose={() => {
        if (!lock.current) onClose();
      }}
    >
      <form className="resident-visitor-form" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy}>
          {!row && (
            <>
              <label>
                Visitor name
                <input name="visitorName" required maxLength={120} />
              </label>
              <label>
                Purpose
                <input name="purpose" required maxLength={200} />
              </label>
            </>
          )}
          <label>
            Expected arrival
            <input
              name="expectedArrival"
              type="datetime-local"
              required
              value={arrival}
              onChange={(e) => {
                setArrival(e.target.value);
                setError('');
              }}
            />
          </label>
          <small>
            {communityTimeLabel(zone)}
          </small>
          {!row && (
            <>
              <PhoneNumberInput name="phoneNumber" label="Phone number" defaultCountry="PH" />
              <label>
                Vehicle number
                <input name="vehicleNumber" />
              </label>
            </>
          )}
          <label className="resident-visitor-pet">
            <input
              type="checkbox"
              checked={pet}
              onChange={(e) => {
                setPet(e.target.checked);
                setError('');
              }}
            />
            Visitor will bring a pet
          </label>
          {pet && guidance?.petPermitted === false && <p role="status">{petVisitMessage}</p>}
          {guidance?.authorizationState === 'pending_admin' && (
            <p role="status">
              This invitation is expected to require Community Admin approval. The server confirms
              authorization when you submit.
            </p>
          )}
          {guidanceError && <p role="status">{guidanceError}</p>}
          {row && (
            <p>
              Rescheduling rechecks authorization and pet entry. Any previous Admin authorization is
              reset. Your pass may become unavailable while awaiting approval.
            </p>
          )}
        </fieldset>
        {(error || zoneError) && <p role="alert">{error || zoneError}</p>}
        <div className="button-row">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            type="submit"
            disabled={busy || !!zoneError || (pet && guidance?.petPermitted === false)}
          >
            {busy ? 'Submitting…' : row ? 'Save new visit' : 'Invite Visitor'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
