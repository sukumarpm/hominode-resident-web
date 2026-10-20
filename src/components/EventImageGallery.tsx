import { useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, ImageOff, Maximize2 } from 'lucide-react';
import { Modal } from '../components';
import { safeUrl } from '../data';
import { type Data } from '../models';
import './EventImageGallery.css';

/** Existing shared event/announcement URL fields only; never resolve private IDs. */
export function eventImageUrls(data: Data): string[] {
  const candidates = [
    ...(Array.isArray(data.attachments)
      ? data.attachments.filter((attachment: unknown) => {
          const url = safeUrl(attachment);
          // Announcement attachments may also be documents. Keep opaque image
          // endpoints, but leave known document/media files out of the gallery.
          if (!url) return false;
          try {
            return !/\.(pdf|docx?|xlsx?|pptx?|zip|mp4|mp3)$/i.test(
              decodeURIComponent(new URL(url).pathname),
            );
          } catch {
            return false;
          }
        })
      : []),
    ...(Array.isArray(data.imageUrls) ? data.imageUrls : []),
    ...(Array.isArray(data.images)
      ? data.images.map((image: unknown) =>
          image && typeof image === 'object' && !Array.isArray(image) ? (image as Data).url : image,
        )
      : []),
    data.imageUrl,
  ];
  const urls: string[] = [];
  for (const value of candidates) {
    const url = safeUrl(value);
    if (!url || urls.includes(url)) continue;
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) urls.push(url);
  }
  return urls;
}

export function EventImageGallery({ data, title }: { data: Data; title: string }) {
  const urls = eventImageUrls(data);
  if (!urls.length) return null;
  // Reset selection, errors and full-screen viewing when a record's media changes.
  return <Gallery key={JSON.stringify(urls)} urls={urls} title={title} />;
}

function Gallery({ urls, title }: { urls: string[]; title: string }) {
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const current = urls[selected];
  const unavailable = failed.has(current);
  const move = (offset: number) =>
    setSelected((index) => (index + offset + urls.length) % urls.length);
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (urls.length < 2) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      move(event.key === 'ArrowLeft' ? -1 : 1);
    }
  }
  function photo(full: boolean) {
    return (
      <div className={'event-photo-frame' + (full ? ' event-photo-full' : '')}>
        {unavailable ? (
          <div className="event-photo-unavailable" role="status">
            <ImageOff size={32} aria-hidden="true" />
            <p>Photo unavailable</p>
            <button
              type="button"
              onClick={() =>
                setFailed((previous) => {
                  const next = new Set(previous);
                  next.delete(current);
                  return next;
                })
              }
            >
              Retry photo
            </button>
          </div>
        ) : (
          <img
            key={current}
            src={current}
            alt={`${title} — photo ${selected + 1} of ${urls.length}`}
            referrerPolicy="no-referrer"
            onError={() => setFailed((previous) => new Set(previous).add(current))}
          />
        )}
      </div>
    );
  }
  function navigation() {
    return (
      <div className="event-photo-navigation">
        {urls.length > 1 && (
          <button type="button" aria-label="Previous photo" onClick={() => move(-1)}>
            <ChevronLeft size={18} aria-hidden="true" /> Previous
          </button>
        )}
        <span role="status" aria-live="polite">
          Photo {selected + 1} of {urls.length}
        </span>
        {urls.length > 1 && (
          <button type="button" aria-label="Next photo" onClick={() => move(1)}>
            Next <ChevronRight size={18} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }
  return (
    <section className="event-photo-gallery" aria-label={`${title} photos`} onKeyDown={keyboard}>
      {photo(false)}
      {navigation()}
      <div className="event-photo-tools">
        {urls.length > 1 && (
          <div className="event-photo-choices" aria-label="Choose photo">
            {urls.map((url, index) => (
              <button
                type="button"
                key={url}
                aria-label={`Show photo ${index + 1}`}
                aria-pressed={index === selected}
                onClick={() => setSelected(index)}
              >
                {index + 1}
              </button>
            ))}
          </div>
        )}
        <button type="button" disabled={unavailable} onClick={() => setExpanded(true)}>
          <Maximize2 size={16} aria-hidden="true" /> View full image
        </button>
      </div>
      {expanded && (
        <Modal
          title={`${title} — full image`}
          className="event-photo-viewer"
          onClose={() => setExpanded(false)}
          onCancel={(event) => {
            event.stopPropagation();
            setExpanded(false);
          }}
        >
          {photo(true)}
          {navigation()}
        </Modal>
      )}
    </section>
  );
}
