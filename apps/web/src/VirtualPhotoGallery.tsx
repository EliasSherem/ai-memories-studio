import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Asset } from '@memories/shared';
import { Trash2 } from 'lucide-react';
import { Button } from './components/ui/button';
import { Checkbox } from './components/ui/checkbox';

const GAP = 13;
const CAPTION_HEIGHT = 66;
const OVERSCAN_ROWS = 2;
const VIEWPORT_HEIGHT = 560;

type Props = {
  assets: Asset[];
  mutating: Set<string>;
  disabled?: boolean;
  resetKey: string;
  onSelect: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
  ariaLabel?: string;
  selectionLabel?: (asset: Asset) => string;
  isSelected?: (asset: Asset) => boolean;
  hideDelete?: boolean;
  onInspect?: (asset: Asset) => void;
  renderExtra?: (asset: Asset) => ReactNode;
  extraHeight?: number;
};

/** Mount only the rows near the scroll viewport, regardless of collection size. */
export function VirtualPhotoGallery({ assets, mutating, disabled, resetKey, onSelect, onDelete, ariaLabel = 'Imported photo gallery', selectionLabel, isSelected, hideDelete, onInspect, renderExtra, extraHeight = 0 }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 640, height: VIEWPORT_HEIGHT });
  const [scrollTop, setScrollTop] = useState(0);
  const columns = size.width < 520 ? 2 : size.width < 900 ? 3 : 4;
  const rowHeight = (size.width - GAP * (columns - 1)) / columns + CAPTION_HEIGHT + GAP + extraHeight;
  const rowCount = Math.ceil(assets.length / columns);
  const startRow = Math.max(0, Math.min(Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS, rowCount - 1));
  const endRow = Math.min(rowCount, Math.ceil((scrollTop + size.height) / rowHeight) + OVERSCAN_ROWS);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width) setSize({ width: element.clientWidth || bounds.width, height: element.clientHeight || VIEWPORT_HEIGHT });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  useEffect(() => {
    setScrollTop(0);
    if (viewport.current) viewport.current.scrollTop = 0;
  }, [resetKey]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const maximum = Math.max(0, rowCount * rowHeight - size.height);
    if (element.scrollTop > maximum) { element.scrollTop = maximum; setScrollTop(maximum); }
  }, [rowCount, rowHeight, size.height]);

  const rows = [];
  for (let row = startRow; row < endRow; row++) {
    rows.push(<div key={row} className="virtual-photo-row" style={{ top: row * rowHeight, height: rowHeight - GAP, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {assets.slice(row * columns, (row + 1) * columns).map((asset, column) => <article role="listitem" aria-posinset={row * columns + column + 1} aria-setsize={assets.length} className={`photo-card ${(isSelected?.(asset) ?? asset.selected) ? 'photo-selected' : ''}`} key={asset.id}>
        <div className="photo-image-wrap">{onInspect ? <button type="button" className="photo-inspect" aria-label={`Review ${asset.filename}`} onClick={() => onInspect(asset)}><img src={asset.url} alt={asset.filename} loading="lazy" decoding="async" /></button> : <img src={asset.url} alt={asset.filename} loading="lazy" decoding="async" />}
          <Checkbox className="photo-checkbox" aria-label={selectionLabel?.(asset) ?? `Select ${asset.filename}`} checked={isSelected?.(asset) ?? asset.selected} disabled={disabled || mutating.has(asset.id)} onCheckedChange={() => onSelect(asset)} />
          {!hideDelete && <Button variant="outline" size="icon" className="photo-delete" aria-label={`Delete ${asset.filename}`} title="Delete from local studio" disabled={disabled || mutating.has(asset.id)} onClick={() => onDelete(asset)}><Trash2 size={15} /></Button>}
          <span className={`photo-person ${asset.contributorId}`}>{asset.contributorId === 'person1' ? 'Yours' : 'Theirs'}</span>
        </div>
        <div className="photo-caption"><h3 title={asset.filename}>{asset.filename}</h3><span>{asset.createdAt && !Number.isNaN(Date.parse(asset.createdAt)) ? new Date(asset.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'A moment to remember'}</span></div>
        {renderExtra?.(asset)}
      </article>)}
    </div>);
  }
  return <div ref={viewport} role="list" aria-label={ariaLabel} tabIndex={0} className="virtual-gallery" onScroll={event => setScrollTop(event.currentTarget.scrollTop)} style={{ height: Math.min(VIEWPORT_HEIGHT, rowCount * rowHeight) }}>
    <div className="virtual-gallery-spacer" style={{ height: rowCount * rowHeight }}>{rows}</div>
  </div>;
}
