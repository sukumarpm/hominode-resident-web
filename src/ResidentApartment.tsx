import { Link } from 'react-router-dom';
import { useRows } from './data';
import { dateLabel, first, str, type Session } from './models';
import { ApartmentGallery } from './privateImages';

export function ResidentProfileDetails({
  session,
  showAssignment = true,
}: {
  session: Session;
  showAssignment?: boolean;
}) {
  const data = session.profile.data;
  const displayName = first(data, ['name', 'displayName', 'fullName'], session.profile.name);
  const fullName = str(data.fullName);
  const rows = [
    ['Name', displayName],
    ...(fullName &&
    fullName.toLocaleLowerCase().replace(/\s+/g, ' ') !==
      displayName.toLocaleLowerCase().replace(/\s+/g, ' ')
      ? [['Full name', fullName]]
      : []),
    ['Phone', session.profile.phoneNumber],
    ['Email', str(data.email)],
    ...(showAssignment
      ? [
          ['Unit', session.profile.flatLabel],
          ['Building', str(data.buildingName)],
        ]
      : []),
    ['Resident type', str(data.residentType)],
    ['Approval', str(data.approvalStatus)],
    ['Identity verification', str(data.identityVerificationStatus)],
    ['Status', str(data.status)],
    ['Address', str(data.address)],
    ['Created', data.createdAt ? dateLabel(data.createdAt) : ''],
    ['Updated', data.updatedAt ? dateLabel(data.updatedAt) : ''],
  ];
  return (
    <dl className="detail-fields">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Unit assignment comes from the already-authorized users/{uid} session.
 * flats.flatId is a display alias, not the profile's canonical document ID.
 * Do not issue an incompatible resident read or broaden Rules to work around it.
 */
export function ResidentApartmentInfo({ session }: { session: Session }) {
  const building = useRows(session, 'buildings');
  const data = building.rows.find((row) => row.id === session.profile.buildingId)?.data;
  return (
    <>
      <dl className="detail-fields">
        <div>
          <dt>Unit</dt>
          <dd>
            {first(
              session.profile.data,
              ['flatLabel', 'flatNumber', 'unitLabel'],
              session.profile.flatLabel || 'Assigned unit',
            )}
          </dd>
        </div>
        <div>
          <dt>Building</dt>
          <dd>
            {first(
              data || {},
              ['name', 'buildingName'],
              str(session.profile.data.buildingName) || 'Your building',
            )}
          </dd>
        </div>
        {str(data?.address) && (
          <div>
            <dt>Building address</dt>
            <dd>{str(data?.address)}</dd>
          </div>
        )}
      </dl>
      {building.loading && <p role="status">Loading building details…</p>}
      {building.error && (
        <p role="alert">
          Access to your building details could not be verified. Please retry or contact management.
        </p>
      )}
      <ApartmentGallery
        session={session}
        buildingId={session.profile.buildingId}
        title="Building photos"
      />
      <Link className="outline-link" to={`/${session.community!.slug}/vehicles`}>
        My vehicles
      </Link>
    </>
  );
}
