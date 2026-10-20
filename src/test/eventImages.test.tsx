import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EventImageGallery, eventImageUrls } from '../components/EventImageGallery';

const one =
  'https://firebasestorage.googleapis.com/v0/b/demo/o/event_images%2FA%2Fevent%2Fone.jpg?alt=media';
const two =
  'https://firebasestorage.googleapis.com/v0/b/demo/o/event_images%2FA%2Fevent%2Ftwo.png?alt=media';
const three = 'https://res.cloudinary.com/example/image/upload/historical.jpg';
const show = (data: Record<string, unknown>) =>
  render(<EventImageGallery data={data} title="Community gathering" />);

describe('existing event and announcement URL contract', () => {
  it('preserves Admin Mobile/Web ordering and deduplicates synchronized aliases', () => {
    expect(
      eventImageUrls({
        imageUrl: one,
        imageUrls: [two, one],
        images: [{ url: two, storagePath: 'event_images/A/event/two.png' }, { url: one }],
      }),
    ).toEqual([two, one]);
  });
  it('accepts Web gallery objects and legacy URL-only images', () => {
    expect(eventImageUrls({ images: [{ url: one }, { url: two }] })).toEqual([one, two]);
    expect(eventImageUrls({ imageUrl: three })).toEqual([three]);
  });
  it('keeps announcement attachment ordering without trying to render document files', () => {
    expect(
      eventImageUrls({
        attachments: [two, one, 'https://example.invalid/circular.pdf'],
        imageUrls: [one, two],
      }),
    ).toEqual([two, one]);
  });
  it('ignores malformed, unsafe, local and private references', () => {
    expect(
      eventImageUrls({
        images: [null, {}, 42],
        imageUrls: [
          'file:///device.jpg',
          'javascript:alert(1)',
          'http://example.invalid/a.jpg',
          'hominode-image:private',
          '/local.jpg',
          'https://user:password@example.invalid/a.jpg',
        ],
      }),
    ).toEqual([]);
  });
  it.each([{}, { imageUrls: [] }, { imageUrl: 'invalid' }])(
    'omits the gallery when no usable image is attached: %j',
    (data) => {
      const { container } = show(data);
      expect(container).toBeEmptyDOMElement();
    },
  );
  it('renders one image without unnecessary multi-image controls', () => {
    show({ imageUrl: one });
    expect(screen.getByRole('img')).toHaveAttribute('src', one);
    expect(screen.getByRole('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(screen.getByText('Photo 1 of 1')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Next photo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous photo' })).not.toBeInTheDocument();
  });
  it('navigates ordered images forwards, backwards and by numbered selection', () => {
    show({ imageUrls: [two, one, three] });
    expect(screen.getByRole('img')).toHaveAttribute('src', two);
    fireEvent.click(screen.getByRole('button', { name: 'Next photo' }));
    expect(screen.getByRole('img')).toHaveAttribute('src', one);
    fireEvent.click(screen.getByRole('button', { name: 'Previous photo' }));
    expect(screen.getByRole('img')).toHaveAttribute('src', two);
    fireEvent.click(screen.getByRole('button', { name: 'Previous photo' }));
    expect(screen.getByRole('img')).toHaveAttribute('src', three);
    fireEvent.click(screen.getByRole('button', { name: 'Show photo 2' }));
    expect(screen.getByRole('button', { name: 'Show photo 2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('img')).toHaveAttribute('src', one);
  });
  it('supports keyboard navigation on gallery controls', () => {
    show({ imageUrls: [one, two] });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Next photo' }), { key: 'ArrowRight' });
    expect(screen.getByRole('img')).toHaveAttribute('src', two);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Previous photo' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('img')).toHaveAttribute('src', one);
  });
  it('shows full images with navigation and returns to the selected photo on close', () => {
    show({ imageUrls: [one, two] });
    fireEvent.click(screen.getByRole('button', { name: 'View full image' }));
    const viewer = screen.getByRole('dialog', { name: 'Community gathering — full image' });
    expect(within(viewer).getByRole('img')).toHaveAttribute('src', one);
    fireEvent.click(within(viewer).getByRole('button', { name: 'Next photo' }));
    expect(within(viewer).getByRole('img')).toHaveAttribute('src', two);
    fireEvent.click(within(viewer).getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('src', two);
  });
  it('keeps failed-image handling local, allows retry and leaves other photos navigable', () => {
    show({ imageUrls: [one, two] });
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByText('Photo unavailable')).toBeVisible();
    expect(screen.getByRole('button', { name: 'View full image' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next photo' }));
    expect(screen.getByRole('img')).toHaveAttribute('src', two);
    fireEvent.click(screen.getByRole('button', { name: 'Previous photo' }));
    expect(screen.getByText('Photo unavailable')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry photo' }));
    expect(screen.getByRole('img')).toHaveAttribute('src', one);
    expect(screen.getByRole('button', { name: 'View full image' })).toBeEnabled();
  });
  it('handles full-image load failure without closing event details', () => {
    show({ imageUrl: one });
    fireEvent.click(screen.getByRole('button', { name: 'View full image' }));
    const viewer = screen.getByRole('dialog');
    fireEvent.error(within(viewer).getByRole('img'));
    expect(within(viewer).getByText('Photo unavailable')).toBeVisible();
    fireEvent.click(within(viewer).getByRole('button', { name: 'Retry photo' }));
    expect(within(viewer).getByRole('img')).toHaveAttribute('src', one);
  });
  it('resets selected/error/viewer state when saved images change', () => {
    const { rerender } = show({ imageUrls: [one, two] });
    fireEvent.click(screen.getByRole('button', { name: 'Next photo' }));
    fireEvent.click(screen.getByRole('button', { name: 'View full image' }));
    rerender(<EventImageGallery data={{ imageUrls: [three] }} title="Community gathering" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('src', three);
    expect(screen.getByText('Photo 1 of 1')).toBeVisible();
  });
});
