import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, Copy, ExternalLink, X } from 'lucide-react';
import { Avatar, type TeamRow, type TeamWorklog } from './team';
import { TypeIcon, buildTicketRows, type TeamIssue, type TicketRow } from './tickets';
import { formatHours, readableError } from './utils';
import { loadTicket } from './sync';
import { RangePicker } from './range-picker';

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

type Range = { start: string; end: string };
type RangeData = { worklogs: TeamWorklog[]; issues: TeamIssue[]; sync: { complete: boolean } };
type PersonTicketsProps = { row: TeamRow; issues: TeamIssue[]; periodLabel: string; periodRange: Range; isComplete: boolean; onClose: () => void };

const rangeLabel = (range: Range) => range.start === range.end ? shortDate(range.start) : `${shortDate(range.start)} – ${shortDate(range.end)}`;

export function PersonTickets({ row, issues, periodLabel, periodRange, isComplete, onClose }: PersonTicketsProps) {
  const [priorities, setPriorities] = useState<JiraPriority[]>([]);
  const [range, setRange] = useState<Range>(periodRange);
  const [custom, setCustom] = useState<RangeData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [site, setSite] = useState('');
  const isPeriod = range.start === periodRange.start && range.end === periodRange.end;
  const isValid = Boolean(range.start && range.end && range.start <= range.end);

  useEffect(() => {
    let isCurrent = true;
    loadPriorities().then(list => { if (isCurrent) setPriorities(list); });
    return () => { isCurrent = false; };
  }, []);

  useEffect(() => {
    invoke<{ siteName?: string }>('jira_connection').then(connection => setSite((connection.siteName ?? '').replace(/\/+$/, ''))).catch(() => undefined);
  }, []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  useEffect(() => {
    if (isPeriod || !isValid) { setCustom(null); setError(''); setIsLoading(false); return; }
    let isCurrent = true;
    setIsLoading(true); setError('');
    invoke<RangeData>('get_team_worklogs', {
      projectKeys: [], accountIds: [row.accountId], startDate: range.start, endDate: range.end,
      startedAfter: new Date(`${range.start}T00:00:00`).getTime() - 86_400_000, startedBefore: new Date(`${range.end}T00:00:00`).getTime() + 86_400_000,
      fieldIds: [], ticket: loadTicket('team'),
    })
      .then(result => { if (isCurrent) setCustom(result); })
      .catch(reason => { if (isCurrent) { setCustom(null); setError(readableError(reason)); } })
      .finally(() => { if (isCurrent) setIsLoading(false); });
    return () => { isCurrent = false; };
  }, [isPeriod, isValid, range.start, range.end, row.accountId]);

  const complete = isPeriod ? isComplete : Boolean(custom?.sync.complete);
  const label = isPeriod ? periodLabel : rangeLabel(range);
  const tickets = useMemo(() => {
    if (isPeriod) return buildTicketRows(issues, [...row.logsByDate.values()].flat());
    if (!custom) return [];
    return buildTicketRows(custom.issues, custom.worklogs.filter(log => log.authorId === row.accountId && log.date >= range.start && log.date <= range.end));
  }, [isPeriod, issues, row, custom, range.start, range.end]);
  const groups = useMemo(() => priorityGroups(tickets, priorities), [tickets, priorities]);
  const total = tickets.reduce((sum, ticket) => sum + ticket.periodHours, 0);
  const longest = tickets.reduce((max, ticket) => Math.max(max, ticket.periodHours), 0);
  const share = (hours: number) => total ? hours / total * 100 : 0;
  const sorted = groups.flatMap(group => group.tickets);
  const link = (ticket: TicketRow) => site ? `${site}/browse/${ticket.key}` : '';
  const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const copy = async () => {
    const text = sorted.map(ticket => `${ticket.key} - ${ticket.summary}${link(ticket) ? ` - ${link(ticket)}` : ''}`).join('\n');
    // Also offered as HTML so Slack, Confluence, Jira and email paste each key as a clickable link.
    const html = site ? sorted.map(ticket => `<a href="${escapeHtml(link(ticket))}">${escapeHtml(ticket.key)}</a> - ${escapeHtml(ticket.summary)}`).join('<br>') : '';
    try {
      if (html && typeof ClipboardItem !== 'undefined') await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
      else await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
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
        <p>{tickets.length} {tickets.length === 1 ? 'ticket' : 'tickets'} · {complete ? '' : 'at least '}{formatHours(total)} logged in {label}</p>
      </div></div>

      <div className="range-bar">
        <RangePicker value={range} defaultRange={periodRange} defaultLabel={periodRange.start.slice(0, 7) === periodRange.end.slice(0, 7) && periodRange.start.endsWith('-01') ? 'This month' : 'This week'} onChange={setRange} />
        {!isPeriod && <button type="button" className="range-reset" onClick={() => setRange(periodRange)}>Reset to {periodLabel}</button>}
        <span className="range-copy">
          <button type="button" disabled={!sorted.length} onClick={copy} title="Copies each ticket as a link with its title, one per line">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy tickets'}</button>
        </span>
      </div>

      {!isValid ? <p className="team-detail-empty">Choose a start date that is on or before the end date.</p>
        : isLoading ? <p className="team-detail-empty">Loading tickets…</p>
        : error ? <p className="team-detail-empty">{error}</p>
        : !tickets.length ? <p className="team-detail-empty">{complete ? `No time logged in ${label}.` : `No time loaded for ${label}. Some Jira worklogs could not be loaded.`}</p> : <>
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
        {!complete && <p className="team-note">Some Jira worklogs could not be loaded, so this may be missing tickets.</p>}
      </>}
    </section>
  </div>;
}
