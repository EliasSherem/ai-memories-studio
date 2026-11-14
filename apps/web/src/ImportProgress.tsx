import type { ContributorId, PickerState } from '@memories/shared';
import { Check, Clock3, ExternalLink, LoaderCircle, RotateCcw } from 'lucide-react';
import { Button } from './components/ui/button';
import { Progress } from './components/ui/progress';

export type ImportState = PickerState & {
  completed?: number;
  remaining?: number;
  retrying?: number;
  activeDownloads?: number;
  resumable?: boolean;
  requiresAuthorization?: boolean;
  requiresReselection?: boolean;
  listingComplete?: boolean;
  issueCount?: number;
  duplicates?: number;
};

type Props = {
  picker: ImportState;
  cancelling: boolean;
  actionPending: boolean;
  connectionBlocked?: boolean;
  onCancel: () => void;
  onResume: () => void;
  onRetry: () => void;
  onReconnect: (contributorId: ContributorId) => void;
  onReselect: (contributorId: ContributorId) => void;
};

export function ImportProgress({ picker, cancelling, actionPending, connectionBlocked = false, onCancel, onResume, onRetry, onReconnect, onReselect }: Props) {
  const active = ['waiting', 'ready', 'importing'].includes(picker.status);
  const completed = picker.completed ?? picker.imported;
  const remaining = picker.remaining ?? Math.max(0, picker.total - picker.processed);
  const progress = picker.total ? Math.min(100, Math.round(picker.processed / picker.total * 100)) : 0;
  const discoveringSelection = picker.status === 'importing' && picker.listingComplete === false;
  const needsSelection = picker.requiresReselection || picker.status === 'expired' || picker.status === 'cancelled' && remaining > 0;
  const titles: Record<string, string> = {
    waiting: 'Choose your photos in Google Photos', ready: 'Getting your photos ready', importing: 'Bringing your memories home',
    complete: picker.failed ? 'Import finished with items to retry' : 'Your import is complete', cancelled: 'Selection cancelled', expired: 'Photo selection expired', paused: 'Your import is paused', error: 'This import needs your attention',
  };
  return <section className={`import-status status-${picker.status}`} aria-live="polite" aria-labelledby="import-title">
    <div className="import-status-heading"><span className="import-icon">{active ? <LoaderCircle size={18} className="animate-spin" /> : picker.status === 'complete' ? <Check size={18} /> : <Clock3 size={18} />}</span>
      <div><h3 id="import-title">{titles[picker.status] ?? 'Import progress'}</h3><p>{picker.message ?? (picker.status === 'waiting' ? 'Finish your selection with Done in the other tab. This studio will update automatically.' : picker.status === 'importing' ? 'Your photos are being saved privately on this device. It is safe to leave this page open or return later.' : 'Photos already imported remain safely in your gallery.')}</p></div>
      {active && <Button size="sm" variant="ghost" disabled={cancelling || actionPending} onClick={onCancel}>{cancelling && <LoaderCircle size={13} className="animate-spin" />}{cancelling ? 'Cancelling…' : 'Cancel'}</Button>}
    </div>
    {picker.status !== 'waiting' && picker.status !== 'ready' && <><Progress value={discoveringSelection ? 0 : progress} aria-label="Photo import progress" /><div className="progress-label"><span>{picker.processed.toLocaleString()} of {picker.total.toLocaleString()} processed</span><strong>{discoveringSelection ? 'Counting selections…' : `${progress}%`}</strong></div></>}
    <dl className="import-statistics" aria-label="Import item counts">
      {([{ label: 'Total', value: picker.total }, { label: 'Completed', value: completed }, { label: 'Failed', value: picker.failed }, { label: 'Skipped', value: picker.skipped }, { label: 'Remaining', value: remaining }]).map(stat => <div key={stat.label}><dt>{stat.label}</dt><dd>{stat.value.toLocaleString()}</dd></div>)}
    </dl>
    {discoveringSelection && <p className="worker-note">Finding photos across every page of your Google selection. The total grows until all selected items are listed; downloads have already started.</p>}
    {!!picker.duplicates && <p className="worker-note">{picker.duplicates.toLocaleString()} duplicate {picker.duplicates === 1 ? 'match' : 'matches'} detected. Original photo metadata is preserved.</p>}
    {active && picker.status === 'importing' && <p className="worker-note">{picker.activeDownloads ?? 0} downloading{picker.retrying ? ` · ${picker.retrying} waiting to retry` : ''}. Progress is saved automatically.</p>}
    {!active && <div className="job-actions">
      {picker.requiresAuthorization ? <Button size="sm" variant="outline" disabled={actionPending || connectionBlocked} onClick={() => onReconnect(picker.contributorId)}><ExternalLink size={14} /> Reconnect Google Photos</Button> : needsSelection ? <Button size="sm" variant="outline" disabled={actionPending || connectionBlocked || !!picker.cleanupPending} onClick={() => onReselect(picker.contributorId)}><RotateCcw size={14} /> Choose photos again</Button> : <>
        {picker.failed > 0 && picker.resumable !== false && <Button size="sm" variant="outline" disabled={actionPending} onClick={onRetry}>{actionPending ? <LoaderCircle size={14} className="animate-spin" /> : <RotateCcw size={14} />} Retry failed items</Button>}
        {remaining > 0 && picker.resumable && <Button size="sm" variant="outline" disabled={actionPending} onClick={onResume}>{actionPending && <LoaderCircle size={14} className="animate-spin" />} Resume import</Button>}
      </>}
      {picker.cleanupPending && <span className="worker-note">Google cleanup will be retried automatically.</span>}
    </div>}
    {connectionBlocked && (picker.requiresAuthorization || needsSelection) && <p className="job-recovery-note">Finish or cancel any active import, and wait for Google cleanup before reconnecting or choosing more photos.</p>}
    {needsSelection && <p className="job-recovery-note">The previous Google selection is no longer available. Select the remaining photos again; photos already saved stay in your project and duplicates are detected automatically.</p>}
    {picker.requiresAuthorization && <p className="job-recovery-note">Reconnect the same Google account to continue. If Google can no longer provide this selection, choose the remaining photos again.</p>}
    {picker.issues.length > 0 && <details className="import-issues"><summary>View import notes{picker.issueCount && picker.issueCount > picker.issues.length ? ` (first ${picker.issues.length} of ${picker.issueCount.toLocaleString()})` : ''}</summary><ul>{picker.issues.map((issue, index) => <li key={index}><strong>{issue.filename}</strong>: {issue.message}</li>)}</ul></details>}
  </section>;
}
