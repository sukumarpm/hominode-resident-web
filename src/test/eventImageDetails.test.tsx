import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { ModulePage } from '../pages';
import { AuthContext } from '../session';
import { makeSession } from './fixtures';
import { type Module, type Resource } from '../data';

const fixture = vi.hoisted(() => ({
  resource: { rows: [], loading: false, error: '' } as Resource,
}));
vi.mock('../firebase', () => ({
  call: vi.fn(),
  firebase: vi.fn(() => {
    throw Error('No production Firebase in image tests');
  }),
}));
vi.mock('../data', async () => ({
  ...(await vi.importActual<typeof import('../data')>('../data')),
  useRows: vi.fn(() => fixture.resource),
}));
beforeEach(() => {
  fixture.resource = { rows: [], loading: false, error: '' };
});
const image = 'https://example.invalid/event-photo.jpg';
function mount(module: Module) {
  return render(
    <AuthContext
      value={{
        session: makeSession(),
        loading: false,
        error: '',
        authenticated: true,
        signOut: vi.fn(),
        switchCommunity: vi.fn(),
      }}
    >
      <MemoryRouter initialEntries={[`/green-valley/${module}?record=event`]}>
        <ModulePage module={module} />
      </MemoryRouter>
    </AuthContext>,
  );
}
for (const module of ['events', 'notices'] as const) {
  it(`renders ${module} images alongside existing details`, () => {
    fixture.resource.rows = [
      {
        id: 'event',
        data: {
          communityId: 'community-1',
          title: 'Community gathering',
          description: 'Meet in the garden',
          status: 'active',
          ...(module === 'events'
            ? { images: [{ url: image, storagePath: 'event_images/community-1/event/photo.jpg' }] }
            : { attachments: [image] }),
        },
      },
    ];
    mount(module);
    const details = screen.getByRole('dialog', { name: 'Community gathering' });
    expect(within(details).getByRole('img')).toHaveAttribute('src', image);
    expect(within(details).getByText('Meet in the garden')).toBeVisible();
    fireEvent.click(within(details).getByRole('button', { name: 'View full image' }));
    const viewer = screen.getByRole('dialog', { name: 'Community gathering — full image' });
    fireEvent(viewer, new Event('cancel', { bubbles: false, cancelable: true }));
    expect(
      screen.queryByRole('dialog', { name: 'Community gathering — full image' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Community gathering' })).toBeVisible();
    fireEvent(details, new Event('cancel', { bubbles: false, cancelable: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}
it('does not resurrect a photo or detail when the scoped reader has no accessible record', () => {
  fixture.resource.error = 'This record is unavailable.';
  mount('events');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('removes an open photo viewer when its accessible record disappears', () => {
  fixture.resource.rows = [
    { id: 'event', data: { title: 'Community gathering', imageUrl: image } },
  ];
  const view = mount('events');
  fireEvent.click(screen.getByRole('button', { name: 'View full image' }));
  fixture.resource = { rows: [], loading: false, error: '' };
  view.rerender(
    <AuthContext
      value={{
        session: makeSession(),
        loading: false,
        error: '',
        authenticated: true,
        signOut: vi.fn(),
        switchCommunity: vi.fn(),
      }}
    >
      <MemoryRouter initialEntries={['/green-valley/events?record=event']}>
        <ModulePage module="events" />
      </MemoryRouter>
    </AuthContext>,
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
