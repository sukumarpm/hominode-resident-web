import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Row } from '../models';
import { ModulePage } from '../pages';
import { AuthContext, type AuthState } from '../session';
import { makeSession } from './fixtures';

const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  resource: { rows: [] as Row[], loading: false, error: '' },
}));

vi.mock('../actions', () => ({
  residentNotificationDestination: mocks.route,
}));
vi.mock('../data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data')>();
  return {
    ...actual,
    useRows: () => mocks.resource,
    useResidentV2Payments: () => ({ rows: [], loading: false, error: '' }),
  };
});

function CurrentPath() {
  const { pathname } = useLocation();
  return <output data-testid="path">{pathname}</output>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resource = {
    rows: [
      {
        id: 'notification-1',
        data: {
          title: 'Payment verified',
          message: 'Admin confirmed payment.',
          type: 'payment',
          eventType: 'payment_proof_verified',
          data: { route: 'billing', eventType: 'payment_proof_verified' },
          createdAt: new Date('2026-10-01T12:00:00Z'),
        },
      },
    ],
    loading: false,
    error: '',
  };
});

function mount() {
  const session = makeSession();
  const auth: AuthState = {
    session,
    loading: false,
    error: '',
    authenticated: true,
    signOut: vi.fn(),
    switchCommunity: vi.fn(),
  };
  return render(
    <AuthContext value={auth}>
      <MemoryRouter initialEntries={['/green-valley/notifications']}>
        <CurrentPath />
        <Routes>
          <Route path="/green-valley/notifications" element={<ModulePage module="notifications" />} />
          <Route path="/green-valley/statement" element={<p>Billing V2 statement</p>} />
        </Routes>
      </MemoryRouter>
    </AuthContext>,
  );
}

it('opens the existing Billing V2 statement for a supported payment event', async () => {
  mocks.route.mockResolvedValue('billing');
  mount();
  fireEvent.click(screen.getByRole('button', { name: /Payment verified/ }));
  expect(await screen.findByText('Billing V2 statement')).toBeInTheDocument();
  expect(mocks.route).toHaveBeenCalledTimes(1);
  expect(mocks.route).toHaveBeenCalledWith(expect.objectContaining({ uid: 'resident-1' }), 'notification-1');
});

it('prevents duplicate navigation work from rapid repeated clicks', async () => {
  let resolveRoute!: (destination: 'billing' | 'details') => void;
  mocks.route.mockReturnValue(new Promise((resolve) => (resolveRoute = resolve)));
  mount();
  const card = screen.getByRole('button', { name: /Payment verified/ });
  fireEvent.click(card);
  fireEvent.click(card);
  expect(mocks.route).toHaveBeenCalledTimes(1);
  resolveRoute('billing');
  await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/green-valley/statement'));
});

it('falls back to the existing notification detail for unsupported metadata', async () => {
  mocks.route.mockResolvedValue('details');
  mount();
  fireEvent.click(screen.getByRole('button', { name: /Payment verified/ }));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(screen.getByTestId('path')).toHaveTextContent('/green-valley/notifications');
});

it('does not navigate when the authorized notification record is no longer available', async () => {
  mocks.route.mockRejectedValue(new Error('Notification access denied.'));
  mount();
  fireEvent.click(screen.getByRole('button', { name: /Payment verified/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This notification is no longer available in your community.',
  );
  expect(screen.getByTestId('path')).toHaveTextContent('/green-valley/notifications');
});
