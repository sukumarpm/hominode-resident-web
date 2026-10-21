import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { type ReactNode } from 'react';
import { ProfilePage } from '../pages';
import { AuthContext } from '../session';
import { type Resource } from '../data';
import { type Session } from '../models';
import { makeSession } from './fixtures';

const mock = vi.hoisted(() => ({ rows: [] as Resource['rows'] }));
vi.mock('../firebase', () => ({
  call: vi.fn(),
  firebase: () => {
    throw Error('No production Firebase in surface tests');
  },
}));
vi.mock('../data', async () => ({
  ...(await vi.importActual<typeof import('../data')>('../data')),
  useRows: () => ({ rows: mock.rows, loading: false, error: '' }),
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
});
it('existing apartment page contains the scoped gallery and retains unit details/navigation', () => {
  mock.rows = [{ id: 'unit-1', data: { flatLabel: 'Tower A · 1203' } }];
  render(wrap(<ProfilePage apartment />));
  expect(screen.getByRole('heading', { name: 'My Apartment' })).toBeVisible();
  expect(screen.getAllByText('No photos available.')).toHaveLength(2);
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
