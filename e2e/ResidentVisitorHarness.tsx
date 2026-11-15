// Synthetic callable/snapshot adapter. Imported only by the offline entry point.
import { useState } from 'react';
import { ResidentVisitorForm } from '../src/components/ResidentVisitorForm';
import { ResidentVisitorActions } from '../src/components/ResidentVisitorActions';
import { VisitorQrPass } from '../src/components/VisitorQrPass';
import { makeSession } from '../src/test/fixtures';
import { petVisitMessage } from '../src/residentVisitor';
import type { Row } from '../src/models';
const initial = makeSession();
const session = {
  ...initial,
  community: {
    ...initial.community!,
    data: { ...initial.community!.data, timeZone: 'Asia/Manila' },
  },
};
const token = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno12';
const watch = () => () => {};
const context = async () => ({
  communityId: 'community-1',
  authorizationState: 'pending_admin',
  petPermitted: false,
  policyRevision: 4,
  serverTime: Date.now(),
});
export function ResidentVisitorHarness() {
  const [form, setForm] = useState(false),
    [row, setRow] = useState<Row | null>(null),
    [message, setMessage] = useState('');
  return (
    <main style={{ maxWidth: 900, margin: 'auto', padding: 16 }}>
      <h1>Resident visitor workflow</h1>
      <p>Offline test data only.</p>
      <button onClick={() => setForm(true)}>Invite a Visitor</button>
      {message && <p role="status">{message}</p>}
      {form && (
        <ResidentVisitorForm
          session={session}
          context={context}
          onClose={() => setForm(false)}
          create={async (_s, values, pet) => {
            if (pet) throw Error(petVisitMessage);
            setRow({
              id: 'visitor-1',
              data: {
                communityId: 'community-1',
                hostUserId: 'resident-1',
                residentId: 'resident-1',
                visitorName: values.visitorName,
                purpose: values.purpose,
                flatLabel: 'N014',
                status: 'expected',
                isApproved: false,
                expectedArrival: new Date(Date.now() + 3600000),
                authorizationState: 'pending_admin',
                authorizationManaged: true,
                authorizationRevision: 1,
                bringingPet: false,
              },
            });
            return {
              visitorId: 'visitor-1',
              authorizationState: 'pending_admin',
              credentialsAvailable: false,
            };
          }}
          onSaved={() => setMessage('Invitation submitted. Waiting for your Community Admin.')}
        />
      )}
      {row && (
        <>
          <ResidentVisitorActions
            session={session}
            row={row}
            mutate={async (_s, value, action, changes) => {
              const revision = Number(value.data.authorizationRevision) + 1;
              if (action === 'reschedule' && changes?.bringingPet) throw Error(petVisitMessage);
              setRow({
                ...value,
                data: {
                  ...value.data,
                  authorizationRevision: revision,
                  status: action === 'cancel' ? 'cancelled' : 'expected',
                  authorizationState: action === 'cancel' ? 'revoked' : 'pending_admin',
                  bringingPet: changes?.bringingPet ?? value.data.bringingPet,
                  ...(changes?.expectedArrival
                    ? { expectedArrival: new Date(changes.expectedArrival) }
                    : {}),
                },
              });
              return {
                visitorId: value.id,
                authorizationState: action === 'cancel' ? 'revoked' : 'pending_admin',
                authorizationRevision: revision,
              };
            }}
          />
          <VisitorQrPass
            visitorId={row.id}
            session={session}
            data={row.data}
            watchCommunity={watch}
            loadCredentials={async () => {
              if (row.data.authorizationState !== 'admin_authorized') throw Error('Not authorized');
              return { qrToken: token, visitorPassCode: 'ABCD-EFGHJKLM' };
            }}
          />
          <button
            onClick={() =>
              setRow({
                ...row,
                data: {
                  ...row.data,
                  status: 'approved',
                  isApproved: true,
                  authorizationState: 'admin_authorized',
                  authorizationRevision: Number(row.data.authorizationRevision) + 1,
                },
              })
            }
          >
            Receive synthetic Admin authorization
          </button>
        </>
      )}
    </main>
  );
}
