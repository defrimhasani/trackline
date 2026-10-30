import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ExternalLink, X } from 'lucide-react';
import { Avatar, type TeamRow } from './team';
import { TypeIcon, buildTicketRows, type TeamIssue, type TicketRow } from './tickets';
import { formatHours } from './utils';

export type JiraPriority = { id: string; name: string; iconUrl?: string; color?: string };
type PriorityGroup = { key: string; name: string; iconUrl?: string; color: string; rank: number; hours: number; tickets: TicketRow[] };

// Used when the site's priority list can't be read, and for priorities missing from it.
const commonOrder = ['blocker', 'highest', 'critical', 'high', 'major', 'medium', 'normal', 'low', 'minor', 'lowest', 'trivial'];
const commonColors: Record<string, string> = {
  blocker: '#c9372c', highest: '#c9372c', critical: '#c9372c', high: '#e5684d', major: '#e5684d',
  medium: '#e9a23b', normal: '#e9a23b', low: '#3f8fd6', minor: '#3f8fd6', lowest: '#8a99ad', trivial: '#8a99ad',
};
const otherColor = '#7588e9';
const noPriorityColor = '#b9c5d2';

let prioritiesRequest: Promise<JiraPriority[]> | undefined;
function loadPriorities() {
  prioritiesRequest ??= invoke<JiraPriority[]>('list_priorities').catch(() => { prioritiesRequest = undefined; return []; });
  return prioritiesRequest;
}

function priorityGroups(rows: TicketRow[], priorities: JiraPriority[]): PriorityGroup[] {
  const groups = new Map<string, PriorityGroup>();
  rows.forEach(row => {
    const index = priorities.findIndex(item => (row.priorityId !== undefined && item.id === row.priorityId) || (row.priority !== undefined && item.name === row.priority));
    const known = index >= 0 ? priorities[index] : undefined;
    const name = row.priority ?? known?.name;
    const key = name ?? '';
    let group = groups.get(key);
    if (!group) {
      const common = commonOrder.indexOf(name?.toLowerCase() ?? '');
      const rank = !name ? Number.MAX_SAFE_INTEGER : known ? index : priorities.length + (common >= 0 ? common : commonOrder.length);
      const color = known?.color ?? (name ? commonColors[name.toLowerCase()] ?? otherColor : noPriorityColor);
      group = { key, name: name ?? 'No priority', iconUrl: row.priorityIcon ?? known?.iconUrl, color, rank, hours: 0, tickets: [] };
      groups.set(key, group);
    }
    group.hours += row.periodHours;
    group.tickets.push(row);
  });
  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .map(group => ({ ...group, tickets: [...group.tickets].sort((a, b) => b.periodHours - a.periodHours || a.key.localeCompare(b.key, undefined, { numeric: true })) }));
}

function PriorityIcon({ group }: { group: PriorityGroup }) {
  const [hasFailed, setHasFailed] = useState(false);
  return group.iconUrl && !hasFailed
    ? <img className="priority-icon" src={group.iconUrl} alt="" width={16} height={16} onError={() => setHasFailed(true)} />
    : <i className="priority-swatch" aria-hidden="true" />;
}

const shortDate = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

type PersonTicketsProps = { row: TeamRow; issues: TeamIssue[]; periodLabel: string; isComplete: boolean; onClose: () => void };

export function PersonTickets({ row, issues, periodLabel, isComplete, onClose }: PersonTicketsProps) {
  const [priorities, setPriorities] = useState<JiraPriority[]>([]);

  useEffect(() => {
    let isCurrent = true;
    loadPriorities().then(list => { if (isCurrent) setPriorities(list); });
    return () => { isCurrent = false; };
  }, []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  const tickets = useMemo(() => buildTicketRows(issues, [...row.logsByDate.values()].flat()), [issues, row]);
  const groups = useMemo(() => priorityGroups(tickets, priorities), [tickets, priorities]);
  const total = tickets.reduce((sum, ticket) => sum + ticket.periodHours, 0);
  const longest = tickets.reduce((max, ticket) => Math.max(max, ticket.periodHours), 0);
  const share = (hours: number) => total ? hours / total * 100 : 0;
  const ticketTitle = (ticket: TicketRow) => [
    `${ticket.key} · ${ticket.summary}`,
    [ticket.issueType, ticket.status].filter(Boolean).join(' · '),
    [...ticket.logs].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map(log => `${shortDate(log.date)} ${formatHours(log.durationMinutes / 60)}`).join(', '),
    'Click to open in Jira',
  ].filter(Boolean).join('\n');

  return <div className="popover-backdrop" onClick={onClose}>
    <section className="team-detail person-tickets" role="dialog" aria-modal="true" aria-labelledby="person-tickets-title" onClick={event => event.stopPropagation()}>
      <button className="close" onClick={onClose} aria-label="Close"><X size={18} /></button>
      <div className="team-detail-head"><Avatar name={row.name} url={row.avatarUrl} size={34} /><div>
        <h2 id="person-tickets-title">{row.name}</h2>
        <p>{tickets.length} {tickets.length === 1 ? 'ticket' : 'tickets'} · {isComplete ? '' : 'at least '}{formatHours(total)} logged in {periodLabel}</p>
      </div></div>

      {!tickets.length ? <p className="team-detail-empty">{isComplete ? `No time logged in ${periodLabel}.` : `No time loaded for ${periodLabel}. Some Jira worklogs could not be loaded.`}</p> : <>
        <div className="priority-mix">
          <span className="priority-stack" role="img" aria-label={`Hours by priority: ${groups.map(group => `${group.name} ${formatHours(group.hours)}`).join(', ')}`}>
            {groups.map(group => <i key={group.key} style={{ flexGrow: group.hours, background: group.color }} title={`${group.name}: ${formatHours(group.hours)}`} />)}
          </span>
          <ul className="priority-legend" aria-hidden="true">{groups.map(group => <li key={group.key}>
            <i style={{ background: group.color }} />{group.name}<b>{formatHours(group.hours)}</b><small>{Math.round(share(group.hours))}%</small>
          </li>)}</ul>
        </div>

        <div className="priority-chart">{groups.map(group => <section className="priority-group" key={group.key} style={{ '--priority': group.color } as CSSProperties} aria-label={`${group.name} priority`}>
          <h3><PriorityIcon group={group} /><span>{group.name}</span><small>{group.tickets.length} {group.tickets.length === 1 ? 'ticket' : 'tickets'} · {formatHours(group.hours)}</small></h3>
          <ul>{group.tickets.map(ticket => <li key={ticket.key}>
            <button type="button" className="priority-bar-row" title={ticketTitle(ticket)} aria-label={`${ticket.key} ${ticket.summary}, ${formatHours(ticket.periodHours)}. Open in Jira`}
              onClick={() => { invoke('open_issue', { issueKey: ticket.key }).catch(() => undefined); }}>
              <span className="priority-ticket"><TypeIcon row={ticket} /><b>{ticket.key}</b><span>{ticket.summary}</span></span>
              <span className="priority-track" aria-hidden="true"><i style={{ width: `${longest ? Math.max(2, ticket.periodHours / longest * 100) : 0}%` }} /></span>
              <em>{formatHours(ticket.periodHours)}</em>
              <ExternalLink size={13} className="priority-open" aria-hidden="true" />
            </button>
          </li>)}</ul>
        </section>)}</div>
        {!isComplete && <p className="team-note">Some Jira worklogs could not be loaded, so this may be missing tickets.</p>}
      </>}
    </section>
  </div>;
}
