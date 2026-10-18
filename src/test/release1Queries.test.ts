import { expect, it } from 'vitest';
import { querySpec, safeUrl } from '../data';
import { makeSession } from './fixtures';

it('queries tenant-scoped events from the canonical event collection', () => {
  for (const session of [makeSession('admin'), makeSession()]) {
    expect(querySpec(session, 'events')).toEqual({
      collection: 'events_announcements',
      filters: [
        ['communityId', '==', session.community!.id],
        ['type', '==', 'event'],
      ],
    });
  }
});
it('preserves callable Resident announcement discovery alongside the legacy notice collection', () => {
  expect(querySpec(makeSession(), 'notices')).toMatchObject({
    collection: 'notices',
    announcementFeed: 'resident',
    filters: [['communityId', '==', 'community-1']],
  });
});
it('keeps legacy image URLs unchanged without treating private asset IDs as network URLs', () => {
  const legacy = [
    'https://example.invalid/legacy-cloudinary.jpg',
    'https://firebasestorage.googleapis.com/v0/b/demo-images/o/legacy.jpg?alt=media',
  ];
  for (const url of legacy) expect(safeUrl(url)).toBe(url);
  expect(safeUrl('hominode-image:a1111111-1111-4111-8111-111111111111')).toBeUndefined();
});
