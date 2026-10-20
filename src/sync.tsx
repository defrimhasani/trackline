import { TriangleAlert } from 'lucide-react';
import type { SyncStatus } from './utils';

const session = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
const sequences = { calendar: 0, team: 0 };

/** Names one Jira load. The backend stops the previous load on the same channel when a newer one starts, so superseded loads stop spending requests. */
export const loadTicket = (channel: keyof typeof sequences) => ({ channel, session, sequence: ++sequences[channel] });

type SyncNoticeProps = { sync: SyncStatus; onRetry?: () => void; footnote?: string };

/** Says plainly that what is on screen may be short, and why, instead of presenting a partial load as the whole picture. */
export function SyncNotice({ sync, onRetry, footnote }: SyncNoticeProps) {
  if (sync.complete) return null;
  return <div className="sync-notice" role="status">
    <TriangleAlert size={16} aria-hidden="true" />
    <div>
      <strong>Some Jira worklogs may be missing</strong>
      {sync.problems.map(problem => <p key={problem}>{problem}</p>)}
      {footnote && <p>{footnote}</p>}
    </div>
    {onRetry && <button type="button" onClick={onRetry}>Try again</button>}
  </div>;
}
