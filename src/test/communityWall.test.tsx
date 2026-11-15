import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { makeSession } from './fixtures';

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  listeners: [] as Array<{
    next: () => void;
    error: (error: Error) => void;
    stop: ReturnType<typeof vi.fn>;
  }>,
  collection: vi.fn(),
}));
vi.mock('../firebase', () => ({ firebase: () => ({ db: {} }), call: mocks.call }));
vi.mock('firebase/firestore', () => ({
  collection: mocks.collection,
  doc: vi.fn((_db, ...path) => path),
  documentId: () => '__name__',
  query: vi.fn(),
  where: vi.fn(),
  onSnapshot: vi.fn((_ref, next, error) => {
    const listener = { next, error, stop: vi.fn() };
    mocks.listeners.push(listener);
    return listener.stop;
  }),
}));
import { useRows } from '../data';

afterEach(() => {
  vi.clearAllMocks();
  mocks.listeners.length = 0;
});

it('loads the callable feed including legacy posts, and refreshes after a moderation decision', async () => {
  mocks.call
    .mockResolvedValueOnce({
      posts: [
        { id: 'old', content: 'Legacy', createdAtMs: null },
        { id: 'new', content: 'New', createdAtMs: 1000 },
      ],
    })
    .mockResolvedValueOnce({ posts: [{ id: 'old', content: 'Legacy', createdAtMs: null }] });
  const session = makeSession();
  const { result, unmount } = renderHook(() => useRows(session, 'community'));
  expect(result.current.loading).toBe(true);
  await waitFor(() => expect(result.current.rows.map((row) => row.id)).toEqual(['new', 'old']));
  expect(mocks.call).toHaveBeenCalledWith('readVisibleWall', {});
  expect(mocks.collection).not.toHaveBeenCalled();
  act(() => mocks.listeners[0].next());
  await waitFor(() => expect(result.current.rows.map((row) => row.id)).toEqual(['old']));
  unmount();
  expect(mocks.listeners[0].stop).toHaveBeenCalledOnce();
});

it('shows empty and error states and never publishes an obsolete response', async () => {
  let complete!: (value: unknown) => void;
  mocks.call
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValueOnce({ posts: [] });
  const session = makeSession();
  const { result, unmount } = renderHook(() => useRows(session, 'community'));
  act(() => mocks.listeners[0].next());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.rows).toEqual([]);
  await act(async () => {
    complete({ posts: [{ id: 'stale' }] });
  });
  expect(result.current.rows).toEqual([]);
  act(() => mocks.listeners[0].error(Error('denied')));
  expect(result.current.error).toContain('unavailable');
  unmount();
});

it('fails closed on a malformed or rejected callable response', async () => {
  mocks.call.mockResolvedValueOnce({ posts: [{ content: 'missing id' }] });
  const session = makeSession();
  const first = renderHook(() => useRows(session, 'community'));
  await waitFor(() => expect(first.result.current.error).toContain('unavailable'));
  expect(first.result.current.rows).toEqual([]);
  first.unmount();
  mocks.call.mockRejectedValueOnce(Error('permission-denied'));
  const second = renderHook(() => useRows(session, 'community'));
  await waitFor(() => expect(second.result.current.error).toContain('unavailable'));
  second.unmount();
});

it('clears the old feed when the signed-in resident changes', async () => {
  let complete!: (value: unknown) => void;
  mocks.call
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValueOnce({ posts: [{ id: 'new-scope', content: 'Visible' }] });
  const first = makeSession();
  const second = { ...makeSession(), uid: 'resident-2' };
  const { result, rerender, unmount } = renderHook(({ session }) => useRows(session, 'community'), {
    initialProps: { session: first },
  });
  rerender({ session: second });
  await waitFor(() => expect(result.current.rows.map((row) => row.id)).toEqual(['new-scope']));
  await act(async () => {
    complete({ posts: [{ id: 'old-scope' }] });
  });
  expect(result.current.rows.map((row) => row.id)).toEqual(['new-scope']);
  expect(mocks.listeners[0].stop).toHaveBeenCalledOnce();
  unmount();
});
