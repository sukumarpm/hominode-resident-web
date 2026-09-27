import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { collection, onSnapshot, query } from 'firebase/firestore';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { querySpec, type Module } from '../data';
import { type Data, type Session } from '../models';
import { facilityPrice, ModulePage } from '../pages';
import { AuthContext, type AuthState } from '../session';
import { makeSession } from './fixtures';

const mocks = vi.hoisted(() => ({
  listeners: [] as { next: (snapshot: unknown) => void; stop: ReturnType<typeof vi.fn> }[],
}));
vi.mock('../firebase', () => ({ firebase: () => ({ db: {} }), call: vi.fn() }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db, name) => name),
  doc: vi.fn(),
  documentId: () => '__name__',
  query: vi.fn((...args) => args),
  where: vi.fn((...args) => args),
  serverTimestamp: vi.fn(),
  onSnapshot: vi.fn((_query, next) => {
    const listener = { next, stop: vi.fn() };
    mocks.listeners.push(listener);
    return listener.stop;
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.length = 0;
});
function mount(
  module: Module = 'facilities',
  record = '',
  session: Session | null = makeSession(),
) {
  const auth: AuthState = {
    session,
    loading: false,
    error: '',
    authenticated: !!session,
    signOut: vi.fn(),
    switchCommunity: vi.fn(),
  };
  return render(
    <AuthContext value={auth}>
      <MemoryRouter initialEntries={['/green-valley/' + module + record]}>
        <ModulePage module={module} />
      </MemoryRouter>
    </AuthContext>,
  );
}
function emit(records: Data[], index = 0) {
  act(() =>
    mocks.listeners[index].next({
      docs: records.map((data, i) => ({ id: String(i), data: () => data })),
    }),
  );
}

function residentSession(residentType?: unknown, ownershipType: unknown = residentType): Session {
  const session = makeSession();
  const data: Data = { ...session.profile.data };
  delete data.residentType;
  delete data.ownershipType;

  if (residentType !== undefined) data.residentType = residentType;
  if (ownershipType !== undefined) data.ownershipType = ownershipType;

  return {
    ...session,
    profile: {
      ...session.profile,
      data,
    },
  };
}
const facility = (data: Data = {}): Data => ({
  communityId: 'community-1',
  name: 'Pool',
  isAvailable: true,
  ...data,
});

it('exposes only explicitly available facilities in cards, counts, search and deep links', () => {
  mount('facilities', '?record=1');
  emit([
    facility(),
    facility({ name: 'Closed gym', isAvailable: false }),
    { communityId: 'community-1', name: 'Legacy hall' },
    facility({ name: 'Malformed flag', isAvailable: 'true' }),
  ]);
  expect(screen.getByRole('heading', { name: 'Pool' })).toBeInTheDocument();
  expect(screen.queryByText('Closed gym')).not.toBeInTheDocument();
  expect(screen.queryByText('Legacy hall')).not.toBeInTheDocument();
  expect(screen.queryByText('Malformed flag')).not.toBeInTheDocument();
  expect(screen.getByText(/Total facilities/)).toHaveTextContent('1 Total facilities');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(
    screen.getByText('This record is no longer available in your community.'),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search facilities' }), {
    target: { value: 'Closed gym' },
  });
  expect(screen.getByText('No matches. Try another search or status.')).toBeInTheDocument();
});

it('shows an empty state for legacy or unavailable facilities and removes an open detail when disabled', () => {
  mount('facilities', '?record=0');
  emit([facility()]);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  emit([facility({ isAvailable: false }), { communityId: 'community-1', name: 'Legacy' }]);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByText('No facilities to display yet.')).toBeInTheDocument();
  expect(screen.getByText(/Total facilities/)).toHaveTextContent('0 Total facilities');
});

it('renders canonical details and Free even when a price exists', () => {
  mount('facilities', '?record=0');
  emit([
    facility({
      type: 'Swimming pool',
      description: 'Shared pool',
      buildingName: 'Tower A',
      isFree: true,
      pricePerDay: 500,
      maxCapacity: 20,
      capacity: 999,
      timeSlots: ['09:00 - 10:00', 'Evening', null, {}, 42],
      bookingDurations: ['1 hour', '2 hours'],
    }),
  ]);
  const dialog = within(screen.getByRole('dialog'));
  for (const text of [
    'Swimming pool',
    'Shared pool',
    'Tower A',
    'Free',
    '20',
    'Yes',
    '09:00 - 10:00, Evening',
    '1 hour, 2 hours',
  ]) {
    expect(dialog.getByText(text)).toBeInTheDocument();
  }
  expect(dialog.queryByText('999')).not.toBeInTheDocument();
  expect(dialog.queryByText(/₹500/)).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /My bookings/ })).toHaveAttribute(
    'href',
    '/green-valley/bookings',
  );
});

it.each([250, '250', 0])('renders a safe paid daily price for %s', (pricePerDay) => {
  mount('facilities', '?record=0');
  emit([facility({ isFree: false, pricePerDay })]);
  expect(
    within(screen.getByRole('dialog')).getByText(`₹${Number(pricePerDay)}.00 / day`),
  ).toBeInTheDocument();
});

it('renders explicit free and flat pricing modes', () => {
  mount('facilities', '?record=0');
  emit([
    facility({
      pricingMode: 'free',
      isFree: true,
      pricePerDay: 0,
    }),
  ]);
  expect(within(screen.getByRole('dialog')).getByText('Free')).toBeInTheDocument();

  emit([
    facility({
      pricingMode: 'flat',
      isFree: false,
      pricePerDay: 275.5,
    }),
  ]);
  expect(within(screen.getByRole('dialog')).getByText('₹275.50 / day')).toBeInTheDocument();
});

it('shows only the owner fee for resident-type pricing', () => {
  mount('facilities', '?record=0', residentSession('owner'));
  emit([
    facility({
      pricingMode: 'resident_type',
      isFree: false,
      pricePerDay: 0,
      ownerPricePerDay: 100,
      tenantPricePerDay: 150,
    }),
  ]);

  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByText('₹100.00 / day')).toBeInTheDocument();
  expect(dialog.queryByText('₹150.00 / day')).not.toBeInTheDocument();
});

it('shows only the tenant fee for resident-type pricing', () => {
  mount('facilities', '?record=0', residentSession('tenant'));
  emit([
    facility({
      pricingMode: 'resident_type',
      isFree: false,
      pricePerDay: 0,
      ownerPricePerDay: 100,
      tenantPricePerDay: 150,
    }),
  ]);

  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByText('₹150.00 / day')).toBeInTheDocument();
  expect(dialog.queryByText('₹100.00 / day')).not.toBeInTheDocument();
});

it.each([
  ['missing resident type', residentSession()],
  ['invalid resident type', residentSession('guest')],
  ['mismatched resident declarations', residentSession('owner', 'tenant')],
])('fails closed for resident-type pricing with %s', (_label, session) => {
  expect(
    facilityPrice(
      facility({
        pricingMode: 'resident_type',
        isFree: false,
        pricePerDay: 0,
        ownerPricePerDay: 100,
        tenantPricePerDay: 150,
      }),
      session,
    ),
  ).toBe('Price unavailable');
});

it('never falls back to pricePerDay for resident-type pricing', () => {
  mount('facilities', '?record=0', residentSession('owner'));
  emit([
    facility({
      pricingMode: 'resident_type',
      isFree: false,
      pricePerDay: 999,
      ownerPricePerDay: undefined,
      tenantPricePerDay: 150,
    }),
  ]);

  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByText('Price unavailable')).toBeInTheDocument();
  expect(dialog.queryByText('₹999.00 / day')).not.toBeInTheDocument();
  expect(dialog.queryByText('₹150.00 / day')).not.toBeInTheDocument();
});

it('fails closed for an unknown explicit pricing mode', () => {
  mount('facilities', '?record=0', residentSession('owner'));
  emit([
    facility({
      pricingMode: 'future_mode',
      isFree: false,
      pricePerDay: 250,
    }),
  ]);

  expect(within(screen.getByRole('dialog')).getByText('Price unavailable')).toBeInTheDocument();
});

it.each([undefined, null, {}, '', 'bad', Infinity, NaN, -1, true])(
  'handles missing or malformed optional fields and price %s',
  (pricePerDay) => {
    mount('facilities', '?record=0');
    emit([
      facility({
        name: undefined,
        description: {},
        type: [],
        buildingName: null,
        pricePerDay,
        timeSlots: {},
        bookingDurations: null,
        maxCapacity: Infinity,
        imageUrl: {},
        iconName: {},
        isFree: 'true',
      }),
    ]);
    expect(within(screen.getByRole('dialog')).getByText('Price unavailable')).toBeInTheDocument();
    expect(screen.getByLabelText('Facility image unavailable')).toBeInTheDocument();
  },
);

it.each([
  'http://example.com/pool.jpg',
  'javascript:alert(1)',
  'data:image/png;base64,abc',
  undefined,
])('rejects unsafe or missing image %s', (imageUrl) => {
  const { container } = mount();
  emit([facility({ imageUrl })]);
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByLabelText('Facility image unavailable')).toBeInTheDocument();
});

it('renders HTTPS images and falls back when loading fails', () => {
  const { container } = mount();
  emit([facility({ imageUrl: 'https://example.com/pool.jpg', iconName: 'pool' })]);
  const image = container.querySelector('img')!;
  expect(image).toHaveAttribute('src', 'https://example.com/pool.jpg');
  fireEvent.error(image);
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByLabelText('Facility image unavailable')).toBeInTheDocument();
});

it('retains the amenities community query and rejects foreign-community results', () => {
  mount();
  expect(collection).toHaveBeenCalledWith({}, 'amenities');
  expect(query).toHaveBeenCalledWith('amenities', ['communityId', '==', 'community-1']);
  emit([facility(), facility({ name: 'Foreign pool', communityId: 'community-2' })]);
  expect(screen.getByRole('heading', { name: 'Pool' })).toBeInTheDocument();
  expect(screen.queryByText('Foreign pool')).not.toBeInTheDocument();
  const session = makeSession();
  expect(() => querySpec({ ...session, community: null }, 'facilities')).toThrow();
  expect(() =>
    querySpec(
      { ...session, community: { ...session.community!, id: 'community-2' } },
      'facilities',
    ),
  ).toThrow();
});

it('does not subscribe without a resident session', () => {
  mount('facilities', '', null);
  expect(onSnapshot).not.toHaveBeenCalled();
});

it.each([
  ['missing resident type', residentSession()],
  ['invalid resident type', residentSession('guest')],
  ['mismatched resident declarations', residentSession('owner', 'tenant')],
])('does not subscribe facilities for %s', (_label, session) => {
  mount('facilities', '', session);
  expect(onSnapshot).not.toHaveBeenCalled();
});

it.each(['confirmed', 'cancelled', 'completed'])(
  'preserves %s booking history independently of facility availability',
  (status) => {
    mount('bookings', '?record=0');
    expect(query).toHaveBeenCalledWith(
      'bookings',
      ['communityId', '==', 'community-1'],
      ['userId', '==', 'resident-1'],
    );
    emit([
      {
        communityId: 'community-1',
        userId: 'resident-1',
        amenityId: 'disabled-facility',
        amenityName: 'Historical pool',
        isAvailable: false,
        status,
        timeSlot: '09:00 - 10:00',
        cancellationReason: 'Plans changed',
      },
      { communityId: 'community-1', userId: 'another-resident', amenityName: 'Private booking' },
      { communityId: 'community-2', userId: 'resident-1', amenityName: 'Foreign booking' },
    ]);
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByRole('heading', { name: 'Historical pool' })).toBeInTheDocument();
    expect(dialog.getByText('09:00 - 10:00')).toBeInTheDocument();
    expect(dialog.getByText('Plans changed')).toBeInTheDocument();
    expect(dialog.getAllByText(status).length).toBeGreaterThan(0);
    expect(screen.queryByText('Private booking')).not.toBeInTheDocument();
    expect(screen.queryByText('Foreign booking')).not.toBeInTheDocument();
    expect(collection).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: /cancel booking|book now/i }),
    ).not.toBeInTheDocument();
  },
);
