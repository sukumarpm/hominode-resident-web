import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { type ReactNode } from 'react';
import { ProfilePage, ModulePage } from '../pages';
import { AuthContext } from '../session';
import { type Resource } from '../data';
import { type Session } from '../models';
import { makeSession } from './fixtures';

const mock = vi.hoisted(() => ({
  rows: [] as Resource['rows'],
  error: '',
  modules: [] as string[],
}));
vi.mock('../firebase', () => ({
  call: vi.fn(),
  firebase: () => {
    throw Error('No production Firebase in surface tests');
  },
}));
vi.mock('../data', async () => ({
  ...(await vi.importActual<typeof import('../data')>('../data')),
  useRows: (_session: Session, module: string) => {
    mock.modules.push(module);
    return { rows: mock.rows, loading: false, error: mock.error };
  },
  useApartmentImages: () => ({ rows: [], loading: false, error: '' }),
  useAdminV2PaymentProofs: () => ({ rows: [], loading: false, error: '' }),
  useAdminV2RecurringSchedules: () => ({ rows: [], loading: false, error: '' }),
}));
vi.mock('../subscriptionContext', () => ({
  useSubscription: () => ({ entitlement: null, loading: false, error: '' }),
}));
function wrap(child: ReactNode, s: Session = makeSession(), path = '/') {
  return (
    <AuthContext
      value={{
        session: s,
        loading: false,
        error: '',
        authenticated: true,
        signOut: vi.fn(),
        switchCommunity: vi.fn(),
      }}
    >
      <MemoryRouter initialEntries={[path]}>{child}</MemoryRouter>
    </AuthContext>
  );
}
beforeEach(() => {
  mock.rows = [];
  mock.error = '';
  mock.modules = [];
});
it('My Apartment keeps building and legacy galleries without querying unsupported unit photos', () => {
  mock.rows = [{ id: 'unit-1', data: { flatLabel: 'Tower A · 1203' } }];
  render(wrap(<ProfilePage apartment />));
  expect(screen.getByRole('heading', { name: 'My Apartment' })).toBeVisible();
  expect(screen.getAllByText('No photos available.')).toHaveLength(2);
  expect(screen.queryByRole('region', { name: 'Community photos' })).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Building photos' })).toBeVisible();
  expect(screen.queryByRole('region', { name: 'Apartment photos' })).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Legacy photos (read-only)' })).toBeVisible();
  expect(mock.modules).toEqual(['buildings']);
  expect(screen.getByText('Tower A · 1203')).toBeVisible();
  expect(screen.getByRole('link', { name: 'My vehicles' })).toHaveAttribute(
    'href',
    '/green-valley/vehicles',
  );
});

it('Resident profile displays existing profile image and retains account details', async () => {
  const session = makeSession();
  session.profile.data.profileImage = 'https://example.invalid/profile.jpg';
  render(wrap(<ProfilePage />, session));
  expect(await screen.findByRole('img')).toHaveAttribute(
    'src',
    'https://example.invalid/profile.jpg',
  );
  expect(screen.getByRole('heading', { name: 'My Profile' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

it('profile aliases have one Name label, preserving a genuinely distinct full name', () => {
  const s = makeSession();
  s.profile.data = { ...s.profile.data, name: 'Maya Rao', fullName: 'Maya Rao' };
  const view = render(wrap(<ProfilePage />, s));
  expect(screen.getAllByText('Name', { selector: 'dt' })).toHaveLength(1);
  expect(screen.queryByText('Full name', { selector: 'dt' })).not.toBeInTheDocument();
  const changed = {
    ...s,
    profile: { ...s.profile, data: { ...s.profile.data, fullName: 'Maya Ramesh Rao' } },
  };
  view.rerender(wrap(<ProfilePage />, changed));
  expect(screen.getByText('Full name', { selector: 'dt' })).toBeVisible();
  expect(screen.getByText('Maya Ramesh Rao')).toBeVisible();
});
it('building permission failure remains contextual while independent photo state is shown', () => {
  mock.error = 'Missing or insufficient permissions';
  render(wrap(<ProfilePage apartment />));
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Access to your building details could not be verified',
  );
  expect(screen.getAllByText('No photos available.')).toHaveLength(2);
  expect(mock.modules).not.toContain('units');
});
it('existing Community module shows community gallery alongside its existing feed', () => {
  render(wrap(<ModulePage module="community" />));
  expect(screen.getByRole('region', { name: 'Community photos' })).toBeVisible();
  expect(screen.queryByRole('region', { name: 'Building photos' })).not.toBeInTheDocument();
});
