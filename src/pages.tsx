import { serverTimestamp } from 'firebase/firestore';
import {
  ArrowRight,
  Building2,
  CalendarDays,
  CreditCard,
  Download,
  Dumbbell,
  FileText,
  LayoutGrid,
  List as ListIcon,
  LoaderCircle,
  MapPin,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
  Waves,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  createComplaint,
  createVisitor,
  currentAuthority,
  latestPaymentForBill,
  publishNotice,
  receiptBlob,
  residentLifecycle,
  submitProof,
  updateScoped
} from './actions';
import { AdminCreateButtons, ResidentReview } from './AdminTools';
import { Card, Modal, Pill, State } from './components';
import { PhoneNumberInput } from './components/PhoneNumberInput';
import { safeUrl, titleOf, useRows, type Module } from './data';
import { call } from './firebase';
import {
  amount,
  dateLabel,
  first,
  money,
  status,
  str,
  type Data,
  type Row,
  type Session,
} from './models';
import { useAuth } from './session';
export const labels: Record<Module, string> = {
  residents: 'Residents',
  buildings: 'Buildings',
  units: 'Units',
  visitors: 'Visitors',
  complaints: 'Complaints',
  facilities: 'Facilities',
  bookings: 'Bookings',
  billing: 'Bills & Payments',
  payments: 'Payment Proofs',
  notices: 'Notices',
  events: 'Events',
  documents: 'Documents',
  community: 'Community Wall',
  messages: 'Messages',
  vehicles: 'Vehicles',
  parking: 'Parking',
  deliveries: 'Deliveries',
  notifications: 'Notifications',
  sos: 'Emergency SOS',
  communities: 'Communities',
  admins: 'Administrators',
};
const descriptions: Partial<Record<Module, string>> = {
  residents: 'The people who make your community home.',
  visitors: 'A warm welcome, with peace of mind.',
  complaints: 'Follow every request from report to resolution.',
  facilities: 'Spaces to connect, unwind and enjoy.',
  billing: 'A clear view of your community payments.',
  notices: 'Stay connected to what’s happening around you.',
  buildings: 'Your community, building by building.',
  notifications: 'Updates that matter to you.',
  documents: 'Community documents and circulars.',
  community: 'Stories and updates from your neighbors.',
};
const details: Record<string, string> = {
  name: 'Name',
  fullName: 'Name',
  visitorName: 'Visitor',
  phoneNumber: 'Phone',
  email: 'Email',
  flatLabel: 'Unit',
  buildingName: 'Building',
  residentType: 'Resident type',
  approvalStatus: 'Approval',
  identityVerificationStatus: 'Identity verification',
  purpose: 'Purpose',
  expectedArrival: 'Expected arrival',
  actualArrival: 'Arrival',
  departure: 'Departure',
  visitorPassCode: 'Visitor pass',
  vehicleNumber: 'Vehicle number',
  description: 'Description',
  content: 'Content',
  category: 'Category',
  assignedTo: 'Assigned to',
  technicianPhone: 'Technician phone',
  progressUpdate: 'Progress',
  resolution: 'Resolution',
  resolvedAt: 'Resolved at',
  dueDate: 'Due date',
  amount: 'Amount',
  status: 'Status',
  date: 'Date',
  timeSlot: 'Time slot',
  amenityName: 'Facility',
  numberOfPeople: 'People',
  cancellationReason: 'Cancellation reason',
  location: 'Location',
  eventDate: 'Event date',
  createdAt: 'Created',
  updatedAt: 'Updated',
  body: 'Message',
  lastMessage: 'Last message',
  rejectionReason: 'Rejection reason',
  isAvailable: 'Available',
  capacity: 'Capacity',
  pricePerDay: 'Daily price',
  address: 'Address',
  slug: 'Community address',
};
function descriptionValue(key: string, value: unknown) {
  if (key === 'amount' || key === 'pricePerDay')
    return typeof value === 'number' ? money(value) : '—';
  if (/At$|Date$|Arrival$|^departure$|^date$/.test(key)) return dateLabel(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
export function DetailFields({ data }: { data: Data }) {
  return (
    <dl className="detail-fields">
      {Object.entries(details).map(([key, label]) => {
        const value = descriptionValue(key, data[key]);
        return value && value !== '—' ? (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ) : null;
      })}
    </dl>
  );
}
function pageBase(s: Session) {
  return s.role === 'resident' ? '/' + s.community!.slug + '/' : '/';
}
type FacilityResidentType = 'owner' | 'tenant';

function nonNegativeFacilityPrice(value: unknown) {
  const price =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(price) && price >= 0 ? price : null;
}

function facilityResidentType(s: Session): FacilityResidentType | null {
  const declarations = [s.profile.data.residentType, s.profile.data.ownershipType]
    .map((value) => str(value).trim().toLowerCase())
    .filter(Boolean);

  if (!declarations.length) return null;
  if (declarations.some((value) => value !== 'owner' && value !== 'tenant')) return null;
  if (new Set(declarations).size !== 1) return null;

  return declarations[0] as FacilityResidentType;
}

function dailyFacilityPrice(value: unknown) {
  const price = nonNegativeFacilityPrice(value);
  return price == null ? 'Price unavailable' : `${money(price)} / day`;
}

export function facilityPrice(data: Data, s: Session) {
  const pricingMode = str(data.pricingMode).trim();

  if (pricingMode) {
    if (pricingMode === 'free') {
      return data.isFree === true && nonNegativeFacilityPrice(data.pricePerDay) === 0
        ? 'Free'
        : 'Price unavailable';
    }

    if (pricingMode === 'flat') {
      return data.isFree === false ? dailyFacilityPrice(data.pricePerDay) : 'Price unavailable';
    }

    if (pricingMode === 'resident_type') {
      if (data.isFree !== false || nonNegativeFacilityPrice(data.pricePerDay) !== 0) {
        return 'Price unavailable';
      }

      const residentType = facilityResidentType(s);
      if (!residentType) return 'Price unavailable';

      return dailyFacilityPrice(
        residentType === 'owner' ? data.ownerPricePerDay : data.tenantPricePerDay,
      );
    }

    return 'Price unavailable';
  }

  // Legacy compatibility: records created before pricingMode existed.
  if (data.isFree === true) return 'Free';
  if (data.isFree === false) return dailyFacilityPrice(data.pricePerDay);
  return 'Price unavailable';
}
function FacilityImage({ data }: { data: Data }) {
  const url = safeUrl(data.imageUrl);
  const [failedUrl, setFailedUrl] = useState<string>();
  const iconName = str(data.iconName);
  const Icon = iconName === 'fitness_center' || iconName === 'gym'
    ? Dumbbell
    : iconName === 'pool' ? Waves : Building2;
  return (
    <div className="facility-image">
      {url && url !== failedUrl ? (
        <img loading="lazy" src={url} alt="" onError={() => setFailedUrl(url)} />
      ) : (
        <Icon size={44} aria-label="Facility image unavailable" />
      )}
    </div>
  );
}
function FacilityFields({ data, s }: { data: Data; s: Session }) {
  const list = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && !!item.trim())
      : [];
  const fields: [string, string][] = [
    ['Name', str(data.name)],
    ['Type', str(data.type)],
    ['Description', str(data.description)],
    ['Building', str(data.buildingName)],
    ['Daily price', facilityPrice(data, s)],
    ['Time slots', list(data.timeSlots).join(', ')],
    ['Booking durations', list(data.bookingDurations).join(', ')],
    ['Capacity', typeof data.maxCapacity === 'number' && Number.isFinite(data.maxCapacity) && data.maxCapacity > 0 ? String(data.maxCapacity) : ''],
    ['Available', data.isAvailable === true ? 'Yes' : data.isAvailable === false ? 'No' : 'Unspecified'],
  ];
  return (
    <dl className="detail-fields">
      {fields.filter(([, value]) => value).map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  );
}

type FacilityCategory = 'all' | 'indoor' | 'outdoor' | 'recreation';
type FacilityView = 'grid' | 'list';
type FacilitySort = 'name-asc' | 'name-desc';

function facilityList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : [];
}

function facilityCategoryOf(data: Data): Exclude<FacilityCategory, 'all'> {
  const type = str(data.type).trim().toLowerCase();

  if (
    ['swimming', 'pool', 'playground', 'garden', 'park', 'lawn'].some((word) =>
      type.includes(word),
    )
  ) {
    return 'outdoor';
  }

  if (
    ['recreation', 'sports court', 'badminton', 'tennis', 'basketball'].some((word) =>
      type.includes(word),
    )
  ) {
    return 'recreation';
  }

  return 'indoor';
}

function facilityCapacity(data: Data) {
  const value = data.maxCapacity;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? `${value} ${value === 1 ? 'person' : 'people'}`
    : 'Not specified';
}

function facilityPackagePrices(data: Data) {
  const raw = data.subscriptionPackages;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];

  return Object.entries(raw as Record<string, unknown>)
    .map(([label, value]) => {
      const price = nonNegativeFacilityPrice(value);
      return price == null ? null : [label, money(price)] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry != null)
    .slice(0, 3);
}

function FacilityCard({
  row,
  s,
  base,
  onOpen,
}: {
  row: Row;
  s: Session;
  base: string;
  onOpen: () => void;
}) {
  const data = row.data;
  const price = facilityPrice(data, s);
  const isFree = price === 'Free';
  const type = str(data.type) || 'Facility';
  const description = str(data.description) || 'Community facility';
  const building = str(data.buildingName) || 'Community-wide';
  const timeSlots = facilityList(data.timeSlots);
  const durations = facilityList(data.bookingDurations);
  const packages = facilityPackagePrices(data);
  const residentType = facilityResidentType(s);
  const pricingMode = str(data.pricingMode);
  const TypeIcon = /swimming|pool/i.test(type)
    ? Waves
    : /gym|fitness/i.test(type)
      ? Dumbbell
      : Building2;
  const feeLabel =
    pricingMode === 'resident_type'
      ? residentType === 'owner'
        ? 'Your Owner fee'
        : residentType === 'tenant'
          ? 'Your Tenant / Lease fee'
          : 'Your resident fee'
      : 'Facility fee';

  return (
    <article className="facility-showcase-card">
      <div className="facility-showcase-media">
        <FacilityImage data={data} />
        <span className="facility-status-badge available">
          <ShieldCheck size={14} />
          Available
        </span>
        <span className={'facility-price-badge ' + (isFree ? 'free' : 'paid')}>
          <CreditCard size={14} />
          {isFree ? 'Free' : 'Paid'}
        </span>
      </div>

      <div className="facility-showcase-body">
        <div className="facility-title-row">
          <span className="facility-type-icon">
            <TypeIcon size={22} />
          </span>
          <div>
            <h3>{titleOf(data)}</h3>
            <p>{description}</p>
          </div>
        </div>

        <div className="facility-meta-grid">
          <div>
            <CalendarDays size={18} />
            <span>
              <small>Time slots</small>
              <strong>
                {timeSlots.length
                  ? timeSlots.slice(0, 2).join(' · ')
                  : 'Not specified'}
              </strong>
            </span>
          </div>
          <div>
            <Users size={18} />
            <span>
              <small>Max capacity</small>
              <strong>{facilityCapacity(data)}</strong>
            </span>
          </div>
          <div>
            <MapPin size={18} />
            <span>
              <small>Location</small>
              <strong>{building}</strong>
            </span>
          </div>
        </div>

        <div className={'facility-fee-panel ' + (isFree ? 'free' : 'paid')}>
          <div className="facility-fee-heading">
            <CreditCard size={19} />
            <span>{feeLabel}</span>
          </div>
          <div className="facility-fee-value">
            <strong>{price}</strong>
            {isFree && <small>No facility fee</small>}
          </div>
          {!!packages.length && (
            <div className="facility-package-prices">
              {packages.map(([label, value]) => (
                <span key={label}>
                  <small>{label}</small>
                  <strong>{value}</strong>
                </span>
              ))}
            </div>
          )}
        </div>

        {!!durations.length && (
          <div className="facility-feature-chips">
            {durations.slice(0, 4).map((duration) => (
              <span key={duration}>
                <CalendarDays size={13} />
                {duration}
              </span>
            ))}
            {data.allowMultipleBookings === true && (
              <span>
                <Users size={13} />
                Multiple bookings
              </span>
            )}
          </div>
        )}

        <div className="facility-card-actions">
          <button type="button" className="facility-secondary-action" onClick={onOpen}>
            View details
          </button>
          <Link className="facility-primary-action" to={base + 'bookings'}>
            <CalendarDays size={16} />
            My bookings
          </Link>
        </div>
      </div>
    </article>
  );
}

function canCreate(s: Session, m: Module) {
  return (
    (s.role === 'resident' && ['visitors', 'complaints'].includes(m)) ||
    (s.role === 'admin' && m === 'notices')
  );
}
export function ModulePage({ module, routeName }: { module: Module; routeName?: string }) {
  const { session } = useAuth();
  if (!session) return null;
  return (
    <ScopedModule
      key={session.uid + ':' + session.community?.id + ':' + module}
      s={session}
      module={module}
      routeName={routeName}
    />
  );
}
function ScopedModule({
  s,
  module,
  routeName,
}: {
  s: Session;
  module: Module;
  routeName?: string;
}) {
  const [revision, setRevision] = useState(0),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [page, setPage] = useState(0);
  const [facilityCategory, setFacilityCategory] = useState<FacilityCategory>('all');
  const [facilitySort, setFacilitySort] = useState<FacilitySort>('name-asc');
  const [facilityView, setFacilityView] = useState<FacilityView>('grid');
  const [params, setParams] = useSearchParams();
  const source = useRows(s, module, revision);
  // Only explicitly available facilities are exposed to residents, including deep links.
  const resource = s.role === 'resident' && module === 'facilities'
    ? { ...source, rows: source.rows.filter((row) => row.data.isAvailable === true) }
    : source;
  const base = pageBase(s);
  const title = routeName === 'requests' ? 'Service Requests' : labels[module];
  const showCards =
    s.role === 'resident' ||
    ['facilities', 'notices', 'events', 'community', 'buildings'].includes(module);
  const rows = resource.rows.filter(
    (r) =>
      (filter === 'all' || status(r.data) === filter) &&
      [titleOf(r.data), ...Object.values(r.data).filter((v) => typeof v === 'string')]
        .join(' ')
        .toLowerCase()
        .includes(search.toLowerCase()),
  );

  const facilityRows =
    module === 'facilities'
      ? resource.rows
        .filter((row) =>
          [titleOf(row.data), ...Object.values(row.data).filter((value) => typeof value === 'string')]
            .join(' ')
            .toLowerCase()
            .includes(search.toLowerCase()),
        )
        .filter(
          (row) =>
            facilityCategory === 'all' || facilityCategoryOf(row.data) === facilityCategory,
        )
        .sort((a, b) => {
          const compared = titleOf(a.data).localeCompare(titleOf(b.data));
          return facilitySort === 'name-desc' ? -compared : compared;
        })
      : [];

  const facilityCounts =
    module === 'facilities'
      ? resource.rows.reduce(
        (counts, row) => {
          counts.all += 1;
          counts[facilityCategoryOf(row.data)] += 1;
          return counts;
        },
        { all: 0, indoor: 0, outdoor: 0, recreation: 0 },
      )
      : { all: 0, indoor: 0, outdoor: 0, recreation: 0 };

  const selected = resource.rows.find((r) => r.id === params.get('record'));
  const create = params.get('create') === '1' && canCreate(s, module);
  const statuses = [...new Set(resource.rows.map((r) => status(r.data)).filter(Boolean))];
  const pageCount = Math.max(1, Math.ceil(rows.length / 12));
  const currentPage = Math.min(page, pageCount - 1);
  function close() {
    setParams((p) => {
      p.delete('record');
      p.delete('create');
      return p;
    });
  }
  if (module === 'facilities') {
    const facilityPageCount = Math.max(1, Math.ceil(facilityRows.length / 12));
    const facilityCurrentPage = Math.min(page, facilityPageCount - 1);
    const visibleFacilities = facilityRows.slice(
      facilityCurrentPage * 12,
      facilityCurrentPage * 12 + 12,
    );

    const categories: { key: FacilityCategory; label: string }[] = [
      { key: 'all', label: 'All Facilities' },
      { key: 'indoor', label: 'Indoor' },
      { key: 'outdoor', label: 'Outdoor' },
      { key: 'recreation', label: 'Recreation' },
    ];

    return (
      <>
        <section className="facilities-hero">
          <div className="facilities-hero-copy">
            <p className="facilities-breadcrumb">Home <span>›</span> Facilities</p>
            <h1>Facilities</h1>
            <p>Explore the spaces and amenities available within your community.</p>
          </div>
          <div className="facilities-hero-kicker">
            <span>Great amenities</span>
            <span>Stronger</span>
            <span>Community</span>
          </div>
          <Link className="facilities-bookings-link" to={base + 'bookings'}>
            <CalendarDays size={17} />
            My bookings
          </Link>
        </section>

        <section className="facilities-controls" aria-label="Facility filters">
          <div className="facility-category-tabs">
            {categories.map(({ key, label }) => (
              <button
                type="button"
                key={key}
                className={facilityCategory === key ? 'active' : ''}
                aria-pressed={facilityCategory === key}
                onClick={() => {
                  setFacilityCategory(key);
                  setPage(0);
                }}
              >
                {key === 'all' ? (
                  <Building2 size={16} />
                ) : key === 'outdoor' ? (
                  <Waves size={16} />
                ) : key === 'recreation' ? (
                  <Dumbbell size={16} />
                ) : (
                  <Building2 size={16} />
                )}
                {label} ({facilityCounts[key]})
              </button>
            ))}
          </div>

          <div className="facility-toolbar">
            <label className="facility-search">
              <Search size={18} />
              <input
                aria-label="Search facilities"
                placeholder="Search facilities..."
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
              />
            </label>

            <label className="facility-sort">
              <span className="sr-only">Sort facilities</span>
              <select
                aria-label="Sort facilities"
                value={facilitySort}
                onChange={(event) => {
                  setFacilitySort(event.target.value as FacilitySort);
                  setPage(0);
                }}
              >
                <option value="name-asc">Name (A - Z)</option>
                <option value="name-desc">Name (Z - A)</option>
              </select>
            </label>

            <div className="facility-view-toggle" aria-label="Facility view">
              <button
                type="button"
                aria-label="Grid view"
                aria-pressed={facilityView === 'grid'}
                className={facilityView === 'grid' ? 'active' : ''}
                onClick={() => setFacilityView('grid')}
              >
                <LayoutGrid size={17} />
              </button>
              <button
                type="button"
                aria-label="List view"
                aria-pressed={facilityView === 'list'}
                className={facilityView === 'list' ? 'active' : ''}
                onClick={() => setFacilityView('list')}
              >
                <ListIcon size={18} />
              </button>
            </div>

            <button
              type="button"
              className="facility-refresh"
              aria-label="Refresh page data"
              onClick={() => setRevision(revision + 1)}
            >
              <RefreshCw size={17} />
            </button>
          </div>

          <div className="facility-total">
            <strong>{resource.loading ? '…' : resource.error ? '—' : resource.rows.length}</strong>{' '}
            Total facilities
          </div>
        </section>

        <State resource={resource} empty="No facilities to display yet.">
          {!facilityRows.length ? (
            <p className="empty-state">No matches. Try another search or status.</p>
          ) : (
            <div
              className={
                'facility-showcase-grid ' + (facilityView === 'list' ? 'list-view' : '')
              }
            >
              {visibleFacilities.map((row) => (
                <FacilityCard
                  key={row.id}
                  row={row}
                  s={s}
                  base={base}
                  onOpen={() => setParams({ record: row.id })}
                />
              ))}
            </div>
          )}
        </State>

        {facilityRows.length > 12 && (
          <div className="pagination">
            <button
              disabled={facilityCurrentPage === 0}
              onClick={() => setPage(facilityCurrentPage - 1)}
            >
              Previous
            </button>
            <span>
              Page {facilityCurrentPage + 1} of {facilityPageCount}
            </span>
            <button
              disabled={facilityCurrentPage + 1 >= facilityPageCount}
              onClick={() => setPage(facilityCurrentPage + 1)}
            >
              Next
            </button>
          </div>
        )}

        {params.has('record') && !selected && !resource.loading && !resource.error && (
          <p role="status">This record is no longer available in your community.</p>
        )}
        {selected && (
          <RecordDetails key={selected.id} s={s} module={module} row={selected} onClose={close} />
        )}
      </>
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">{s.community?.name || 'Hominode platform'}</p>
          <h1>{title}</h1>
          <p>{descriptions[module] || 'Everything you need, in one place.'}</p>
        </div>
        <div className="page-actions">
          <AdminCreateButtons s={s} module={module} />
          {module === 'billing' && (
            <Link className="outline-link" to={base + 'payments'}>
              Payment proofs <ArrowRight size={16} />
            </Link>
          )}
          {module === 'buildings' && (
            <Link className="outline-link" to={base + 'units'}>
              View units <ArrowRight size={16} />
            </Link>
          )}
          {module === 'facilities' && (
            <Link className="outline-link" to={base + 'bookings'}>
              My bookings <ArrowRight size={16} />
            </Link>
          )}
          {canCreate(s, module) && (
            <button className="primary" onClick={() => setParams({ create: '1' })}>
              <Plus size={18} />
              {module === 'visitors'
                ? 'Invite Visitor'
                : module === 'notices'
                  ? 'Publish Notice'
                  : 'New Request'}
            </button>
          )}
        </div>
      </header>
      <div className="module-summary">
        <span>
          <strong>{resource.loading ? '…' : resource.error ? '—' : resource.rows.length}</strong>{' '}
          Total {title.toLowerCase()}
        </span>
        <span>
          <strong>
            {resource.loading
              ? '…'
              : resource.error
                ? '—'
                : resource.rows.filter((r) =>
                  ['pending', 'expected', 'open'].includes(status(r.data)),
                ).length}
          </strong>{' '}
          Awaiting action
        </span>
        <span className="summary-note">
          <ShieldCheck size={18} /> {s.community?.name || 'Platform registry'}
        </span>
      </div>
      <Card>
        <div className="filters">
          <label className="search-field">
            <Search size={18} />
            <input
              aria-label={'Search ' + title.toLowerCase()}
              placeholder={'Search ' + title.toLowerCase() + '…'}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <label>
            <span className="sr-only">Filter by status</span>
            <select
              aria-label="Filter by status"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">All statuses</option>
              {statuses.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <button
            className="icon-button"
            aria-label="Refresh page data"
            onClick={() => setRevision(revision + 1)}
          >
            <RefreshCw size={19} />
          </button>
        </div>
        <State resource={resource} empty={'No ' + title.toLowerCase() + ' to display yet.'}>
          {!rows.length ? (
            <p className="empty-state">No matches. Try another search or status.</p>
          ) : showCards ? (
            <div className={'module-cards ' + module}>
              {rows.slice(currentPage * 12, currentPage * 12 + 12).map((row) => (
                <button
                  className="module-card"
                  key={row.id}
                  onClick={() => setParams({ record: row.id })}
                >
                  {module === 'facilities' && (
                    <FacilityImage data={row.data} />
                  )}
                  <div className="module-card-body">
                    <div className="card-heading">
                      <span className="record-icon">
                        {module === 'visitors' ? (
                          <span>{titleOf(row.data).slice(0, 2).toUpperCase()}</span>
                        ) : module === 'bookings' ? (
                          <CalendarDays />
                        ) : (
                          <FileText />
                        )}
                      </span>
                      <Pill value={module === 'facilities' ? (row.data.isAvailable === true ? 'Available' : 'Unavailable') : status(row.data)} />
                    </div>
                    <h3>{titleOf(row.data)}</h3>
                    {module === 'facilities' && (
                      <>
                        <p>{[str(row.data.type), str(row.data.buildingName)].filter(Boolean).join(' · ')}</p>
                        <p>{facilityPrice(row.data, s)}</p>
                      </>
                    )}
                    <p>
                      {first(
                        row.data,
                        [
                          'description',
                          'content',
                          'purpose',
                          'flatLabel',
                          'location',
                          'body',
                          'lastMessage',
                        ],
                        'View details',
                      )}
                    </p>
                    <small>
                      {dateLabel(row.data.expectedArrival ?? row.data.date ?? row.data.createdAt)}
                    </small>
                    <span className="card-more">
                      View details <ArrowRight size={16} />
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">
                  {title} in {s.community?.name || 'the platform'}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      {module === 'residents'
                        ? 'Resident'
                        : module === 'visitors'
                          ? 'Visitor'
                          : 'Name / Reference'}
                    </th>
                    <th scope="col">
                      {['billing', 'payments'].includes(module) ? 'Amount' : 'Details'}
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col">Last updated</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(currentPage * 12, currentPage * 12 + 12).map((row) => (
                    <tr key={row.id}>
                      <th scope="row">
                        <strong>{titleOf(row.data)}</strong>
                        <small>
                          {first(row.data, ['phoneNumber', 'email', 'flatLabel'], row.id)}
                        </small>
                      </th>
                      <td>
                        {['billing', 'payments'].includes(module)
                          ? money(amount(row.data))
                          : first(
                            row.data,
                            ['flatLabel', 'description', 'purpose', 'role', 'category'],
                            '—',
                          )}
                      </td>
                      <td>
                        <Pill value={status(row.data)} />
                      </td>
                      <td>{dateLabel(row.data.updatedAt ?? row.data.createdAt)}</td>
                      <td>
                        <button
                          className="text-button"
                          aria-label={'View ' + titleOf(row.data)}
                          onClick={() => setParams({ record: row.id })}
                        >
                          View <ArrowRight size={15} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </State>
        {rows.length > 12 && (
          <div className="pagination">
            <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
              Previous
            </button>
            <span>
              Page {currentPage + 1} of {pageCount}
            </span>
            <button
              disabled={currentPage + 1 >= pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </button>
          </div>
        )}
      </Card>
      {params.has('record') && !selected && !resource.loading && !resource.error && (
        <p role="status">This record is no longer available in your community.</p>
      )}
      {selected && (
        <RecordDetails key={selected.id} s={s} module={module} row={selected} onClose={close} />
      )}{' '}
      {create && <CreateForm s={s} module={module} onClose={close} />}
    </>
  );
}
function CreateForm({ s, module, onClose }: { s: Session; module: Module; onClose: () => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      if (module === 'visitors') await createVisitor(s, data);
      else if (module === 'complaints') await createComplaint(s, data);
      else if (module === 'notices') await publishNotice(s, data);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        module === 'visitors'
          ? 'Invite a Visitor'
          : module === 'notices'
            ? 'Publish a Notice'
            : 'Raise a Request'
      }
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          {module === 'visitors' ? (
            <>
              <label>
                Visitor name
                <input name="visitorName" required maxLength={120} />
              </label>
              <label>
                Purpose
                <input name="purpose" required maxLength={200} />
              </label>
              <label>
                Expected arrival
                <input type="datetime-local" name="expectedArrival" required />
              </label>
              <PhoneNumberInput
                name="phoneNumber"
                label="Phone number"
                defaultCountry="PH"
              />
              <label>
                Vehicle number
                <input name="vehicleNumber" />
              </label>
            </>
          ) : (
            <>
              <label>
                Title
                <input name="title" required maxLength={160} />
              </label>
              {module === 'complaints' && (
                <label>
                  Category
                  <select name="category" required>
                    <option value="plumbing">Plumbing</option>
                    <option value="electrical">Electrical</option>
                    <option value="maintenance">Maintenance</option>
                    <option value="other">Other</option>
                  </select>
                </label>
              )}
              <label>
                {module === 'notices' ? 'Announcement' : 'Description'}
                <textarea
                  name={module === 'notices' ? 'content' : 'description'}
                  rows={5}
                  required
                  maxLength={5000}
                />
              </label>
            </>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <button className="primary" type="submit">
            {busy ? 'Saving…' : module === 'notices' ? 'Publish to community' : 'Submit'}
          </button>
        </fieldset>
      </form>
    </Modal>
  );
}
function RecordDetails({
  s,
  module,
  row,
  onClose,
}: {
  s: Session;
  module: Module;
  row: Row;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [reason, setReason] = useState(''),
    [receipt, setReceipt] = useState(''),
    [latestPayment, setLatestPayment] = useState<Data | null>(null),
    [paymentLoading, setPaymentLoading] = useState(false),
    [selectedPaymentProof, setSelectedPaymentProof] = useState<File | null>(null),
    [uploadingProof, setUploadingProof] = useState(false);
  useEffect(
    () => () => {
      if (receipt) URL.revokeObjectURL(receipt);
    },
    [receipt],
  );
  const d = row.data;
  useEffect(() => {
    let active = true;

    if (module !== 'billing' || s.role !== 'resident') {
      setLatestPayment(null);
      return () => {
        active = false;
      };
    }

    setPaymentLoading(true);

    void latestPaymentForBill(s, row.id)
      .then((payment) => {
        if (active) {
          setLatestPayment(payment);
        }
      })
      .catch((error) => {
        console.error('[BillingPaymentStatus] load failed:', error);

        if (active) {
          setLatestPayment(null);
          setMessage(
            error instanceof Error
              ? `Payment status could not be loaded: ${error.message}`
              : 'Payment status could not be loaded.',
          );
        }
      })
      .finally(() => {
        if (active) {
          setPaymentLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [module, row.id, s]);
  async function submitSelectedPaymentProof() {
    if (!selectedPaymentProof || uploadingProof) return;

    setUploadingProof(true);
    setMessage('');

    try {
      await submitProof(s, row.id, selectedPaymentProof);

      setSelectedPaymentProof(null);

      const payment = await latestPaymentForBill(s, row.id);
      setLatestPayment(payment);

      setMessage('Payment proof submitted. Waiting for management review.');
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Payment proof could not be submitted.',
      );
    } finally {
      setUploadingProof(false);
    }
  }
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage('Saved successfully.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'The action could not be completed.');
    } finally {
      setBusy(false);
    }
  }
  const pendingVisitor =
    ['pending', 'expected'].includes(status(d)) &&
    d.isApproved !== true &&
    d.actualArrival == null &&
    d.departure == null;
  return (
    <Modal title={titleOf(d)} onClose={onClose}>
      <Pill value={module === 'facilities' ? (d.isAvailable === true ? 'Available' : 'Unavailable') : status(d)} />
      {module === 'facilities' ? <FacilityFields data={d} s={s} /> : <DetailFields data={d} />}
      {module === 'complaints' && (
        <ol className="timeline">
          <li>
            <strong>Request submitted</strong>
            <span>{dateLabel(d.createdAt)}</span>
          </li>
          {d.assignedTo != null && (
            <li>
              <strong>Assigned to {str(d.assignedTo)}</strong>
            </li>
          )}
          {d.progressUpdate != null && <li>{str(d.progressUpdate)}</li>}
          {d.resolvedAt != null && (
            <li>
              <strong>Resolved</strong>
              <span>{dateLabel(d.resolvedAt)}</span>
            </li>
          )}
        </ol>
      )}
      {safeUrl(d.fileUrl) && (
        <a
          className="outline-link"
          href={safeUrl(d.fileUrl)}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Download size={17} />
          Open document
        </a>
      )}
      {module === 'buildings' && (
        <Link className="outline-link" to="/units" onClick={onClose}>
          View community units
        </Link>
      )}
      {module === 'facilities' && (
        <p>
          For new bookings, use the Resident mobile app. Your existing bookings are available on the
          Bookings page.
        </p>
      )}
      {module === 'residents' && s.role === 'admin' && <ResidentReview s={s} row={row} />}
      <div className="detail-actions">
        <fieldset disabled={busy}>
          {module === 'notifications' && d.isRead !== true && (
            <button
              className="primary"
              onClick={() => void perform(() => updateScoped(s, 'notifications', row.id, {}))}
            >
              Mark as read
            </button>
          )}
          {module === 'complaints' && s.role === 'admin' && (
            <>
              <label>
                Update status
                <select
                  defaultValue={status(d)}
                  onChange={(e) =>
                    void perform(() =>
                      updateScoped(s, 'complaints', row.id, { status: e.target.value }),
                    )
                  }
                >
                  <option value="pending">Pending</option>
                  <option value="inprogress">In progress</option>
                  <option value="completed">Completed</option>
                </select>
              </label>
            </>
          )}
          {module === 'visitors' && s.role === 'admin' && pendingVisitor && (
            <div className="button-row">
              <button
                className="primary"
                onClick={() =>
                  void perform(() =>
                    updateScoped(s, 'visitors', row.id, {
                      isApproved: true,
                      approvedAt: serverTimestamp(),
                    }),
                  )
                }
              >
                Approve visitor
              </button>
              <button
                onClick={() =>
                  void perform(() =>
                    updateScoped(s, 'visitors', row.id, {
                      status: 'rejected',
                      isApproved: false,
                      rejectedBy: s.uid,
                      rejectedAt: serverTimestamp(),
                    }),
                  )
                }
              >
                Reject visitor
              </button>
            </div>
          )}
          {module === 'residents' && s.role === 'admin' && (
            <button
              onClick={() =>
                void perform(() =>
                  residentLifecycle(
                    s,
                    row.id,
                    d.isActive === true ? 'deactivateResident' : 'reactivateResident',
                  ),
                )
              }
            >
              {d.isActive === true ? 'Deactivate resident' : 'Reactivate resident'}
            </button>
          )}
          {module === 'billing' && s.role === 'resident' && (
            <div className="payment-proof-status">
              {paymentLoading && <p>Checking payment proof status…</p>}

              {!paymentLoading && latestPayment && (
                <>
                  <p>
                    <strong>Payment proof: </strong>
                    {str(latestPayment.status) === 'failed'
                      ? 'Rejected'
                      : str(latestPayment.status) === 'pending'
                        ? 'Pending review'
                        : str(latestPayment.status)}
                  </p>

                  {str(latestPayment.status) === 'failed' &&
                    str(latestPayment.rejectionReason) && (
                      <p>
                        <strong>Rejection reason: </strong>
                        {str(latestPayment.rejectionReason)}
                      </p>
                    )}
                </>
              )}
            </div>
          )}
          {module === 'billing' &&
            s.role === 'resident' &&
            d.status === 'pending' &&
            !paymentLoading &&
            str(latestPayment?.status) !== 'pending' && (
              <div className="payment-proof-submit">
                <label>
                  {str(latestPayment?.status) === 'failed'
                    ? 'Choose new payment proof'
                    : 'Choose payment proof'}

                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/heic,image/heif"
                    disabled={uploadingProof}
                    onChange={(e) => {
                      const file = e.target.files?.[0] ?? null;
                      setSelectedPaymentProof(file);
                      setMessage('');
                    }}
                  />
                </label>

                {selectedPaymentProof && (
                  <div className="selected-payment-proof">
                    <strong>Selected file</strong>
                    <span>{selectedPaymentProof.name}</span>
                    <small>
                      {(selectedPaymentProof.size / 1024 / 1024).toFixed(2)} MB
                    </small>
                  </div>
                )}

                {selectedPaymentProof && (
                  <button
                    type="button"
                    className="primary"
                    disabled={uploadingProof}
                    onClick={() => void submitSelectedPaymentProof()}
                  >
                    {uploadingProof ? (
                      <>
                        <LoaderCircle
                          size={18}
                          className="payment-upload-spinner"
                          aria-hidden="true"
                        />
                        Uploading payment proof…
                      </>
                    ) : str(latestPayment?.status) === 'failed' ? (
                      'Resubmit payment proof'
                    ) : (
                      'Submit payment proof'
                    )}
                  </button>
                )}
              </div>
            )}
          {module === 'payments' && str(d.receiptPath) && (
            <button
              onClick={() =>
                void perform(async () => {
                  const blob = await receiptBlob(s, str(d.receiptPath));
                  setReceipt(URL.createObjectURL(blob));
                })
              }
            >
              View receipt
            </button>
          )}
          {receipt && <img className="receipt-image" src={receipt} alt="Payment receipt" />}
          {module === 'payments' && s.role === 'admin' && d.status === 'pending' && (
            <>
              <button
                className="primary"
                onClick={() =>
                  void perform(async () => {
                    await currentAuthority(s);
                    return call('verifyPaymentProof', { paymentId: row.id });
                  })
                }
              >
                Verify payment
              </button>
              <label>
                Rejection reason
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <button
                disabled={!reason.trim() || busy}
                onClick={() =>
                  void perform(async () => {
                    await currentAuthority(s);
                    return call('rejectPaymentProof', {
                      paymentId: row.id,
                      rejectionReason: reason.trim(),
                    });
                  })
                }
              >
                Reject proof
              </button>
            </>
          )}
        </fieldset>
      </div>
      {message && (
        <p role="status" className="form-message">
          {message}
        </p>
      )}
    </Modal>
  );
}
export function ProfilePage({
  apartment = false,
  settings = false,
}: {
  apartment?: boolean;
  settings?: boolean;
}) {
  const { session: s, signOut } = useAuth();
  if (!s) return null;
  const title = settings ? 'Settings' : apartment ? 'My Apartment' : 'My Profile';
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Your Hominode account</p>
          <h1>{title}</h1>
          <p>{settings ? 'Your account and community preferences.' : 'A place to belong.'}</p>
        </div>
      </header>
      <div className="profile-grid">
        <Card>
          <div className="profile-heading">
            <span className="avatar large">{s.profile.name.slice(0, 2).toUpperCase()}</span>
            <h2>{s.profile.name}</h2>
            <p>{s.community?.name || 'Hominode platform'}</p>
            <Pill value="active" />
          </div>
          <DetailFields data={s.profile.data} />
        </Card>
        <Card title={apartment ? 'Your home' : 'Account access'}>
          {apartment && s.role === 'resident' ? (
            <ApartmentInfo s={s} />
          ) : (
            <>
              <p>You’re signed in with your verified phone number.</p>
              <p>{s.profile.phoneNumber}</p>
              <p>Contact your community administrator to update your registered account details.</p>
              <button onClick={() => void signOut()}>Sign out</button>
            </>
          )}
          {settings && (
            <div className="settings-note">
              <h3>Notifications</h3>
              <p>
                Your community updates are available in the notification center. Use the mobile app
                for push alerts.
              </p>
              <h3>Display</h3>
              <p>This portal follows your browser’s language and date preferences.</p>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
function ApartmentInfo({ s }: { s: Session }) {
  const unit = useRows(s, 'units');
  return (
    <State resource={unit} empty="Your unit details are not available.">
      {unit.rows.map((r) => (
        <DetailFields data={r.data} key={r.id} />
      ))}
      <Link className="outline-link" to={pageBase(s) + 'vehicles'}>
        My vehicles
      </Link>
    </State>
  );
}
export function CommunityPage() {
  const { session: s } = useAuth();
  if (!s?.community) return null;
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Connected living</p>
          <h1>{s.community.name}</h1>
          <p>Your community at a glance.</p>
        </div>
      </header>
      <div className="profile-grid">
        <section className="community-banner lifestyle">
          <h2>
            Better Community.
            <br />
            Happier Living.
          </h2>
          <span>HOMINODE</span>
        </section>
        <Card title="Community information">
          <DetailFields data={s.community.data} />
          <Link className="outline-link" to="/buildings">
            View buildings <ArrowRight size={17} />
          </Link>
        </Card>
      </div>
    </>
  );
}
export function ReportsPage() {
  const { session: s } = useAuth();
  return s ? <ReportData s={s} /> : null;
}
function ReportData({ s }: { s: Session }) {
  const bills = useRows(s, 'billing'),
    residents = useRows(s, 'residents'),
    visitors = useRows(s, 'visitors'),
    complaints = useRows(s, 'complaints');
  const records = [
    ['Residents', residents],
    ['Visitors', visitors],
    ['Complaints', complaints],
    ['Bills', bills],
  ] as const;
  function exportReport() {
    const csv =
      'Metric,Count\r\n' + records.map(([name, r]) => name + ',' + r.rows.length).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'community-report.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Community intelligence</p>
          <h1>Reports</h1>
          <p>Current community totals from your operational records.</p>
        </div>
        <button
          className="primary"
          disabled={records.some(([, r]) => r.loading || !!r.error)}
          onClick={exportReport}
        >
          <Download size={18} />
          Export summary
        </button>
      </header>
      <div className="report-grid">
        {records.map(([title, r]) => (
          <Card title={title} key={title}>
            {r.loading ? (
              <p role="status">Loading…</p>
            ) : r.error ? (
              <p role="alert">{r.error}</p>
            ) : (
              <strong className="report-number">{r.rows.length}</strong>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
export function UnsupportedPage({ title, message }: { title: string; message: string }) {
  return (
    <>
      <header className="page-header">
        <h1>{title}</h1>
      </header>
      <Card>
        <p>{message}</p>
      </Card>
    </>
  );
}
