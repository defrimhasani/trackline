import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowDown, ArrowUp, ExternalLink, Search, X } from 'lucide-react';
import { Avatar, type TeamWorklog } from './team';
import { formatHours, hoursNumber, readableError } from './utils';

export type TeamIssue = {
  key: string; summary: string; project: string; issueType?: string; issueTypeIcon?: string;
  status?: string; statusCategory?: string; parentKey?: string; parentSummary?: string;
  originalEstimateSeconds?: number; timeSpentSeconds?: number; workType?: string; costType?: string;
};
export type JiraField = { id: string; name: string; fieldType: string };
export type TicketFieldConfig = { detected: boolean; workTypeField?: string; costField?: string };
type TicketPerson = { accountId: string; name: string; avatarUrl?: string; hours: number };
export type TicketRow = TeamIssue & { periodHours: number; people: TicketPerson[]; logs: TeamWorklog[] };
type SortKey = 'ticket' | 'workType' | 'cost' | 'estimate' | 'period' | 'total';

const storageKey = 'trackline.ticketFields';
const notSet = 'Not set';
const hoursOf = (seconds?: number) => seconds === undefined || seconds === null ? undefined : seconds / 3600;

const pickField = (fields: JiraField[], patterns: RegExp[]) => {
  for (const pattern of patterns) {
    const matches = fields.filter(field => pattern.test(field.name.trim()));
    const best = matches.find(field => field.fieldType === 'option') ?? matches.find(field => field.fieldType === 'array') ?? matches[0];
    if (best) return best.id;
  }
  return undefined;
};

export function useTicketFields(enabled: boolean) {
  const [config, setConfig] = useState<TicketFieldConfig>(() => {
    try { return { detected: false, ...JSON.parse(localStorage.getItem(storageKey) ?? '{}') }; }
    catch { return { detected: false }; }
  });
  const [options, setOptions] = useState<JiraField[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify(config)); }, [config]);
  useEffect(() => {
    if (!enabled) return;
    let isCurrent = true;
    invoke<JiraField[]>('list_custom_fields')
      .then(fields => {
        if (!isCurrent) return;
        setOptions(fields); setError('');
        setConfig(current => current.detected ? current : {
          detected: true,
          workTypeField: pickField(fields, [/^work ?type$/i, /work ?type/i, /work categor/i]),
          costField: pickField(fields, [/^cost\s*\/\s*capitali[sz]ed$/i, /cost.*capitali[sz]|capitali[sz].*cost/i, /capitali[sz]/i, /\b(capex|opex)\b/i]),
        });
      })
      .catch(reason => { if (isCurrent) setError(readableError(reason)); });
    return () => { isCurrent = false; };
  }, [enabled]);
  return { config, setConfig, options, error, isReady: config.detected || !!error };
}

export function buildTicketRows(issues: TeamIssue[], worklogs: TeamWorklog[]): TicketRow[] {
  const rows = new Map<string, TicketRow>(issues.map(issue => [issue.key, { ...issue, periodHours: 0, people: [], logs: [] }]));
  const people = new Map<string, Map<string, TicketPerson>>();
  worklogs.forEach(log => {
    const row = rows.get(log.issue) ?? rows.set(log.issue, { key: log.issue, summary: log.summary, project: log.issue.split('-')[0], periodHours: 0, people: [], logs: [] }).get(log.issue)!;
    const hours = log.durationMinutes / 60;
    row.periodHours += hours;
    row.logs.push(log);
    const ticketPeople = people.get(log.issue) ?? people.set(log.issue, new Map()).get(log.issue)!;
    const person = ticketPeople.get(log.authorId) ?? { accountId: log.authorId, name: log.authorName, avatarUrl: log.authorAvatar, hours: 0 };
    person.hours += hours;
    ticketPeople.set(log.authorId, person);
  });
  return [...rows.values()].filter(row => row.logs.length).map(row => ({ ...row, people: [...(people.get(row.key)?.values() ?? [])].sort((a, b) => b.hours - a.hours) }));
}

export const costTone = (value?: string) => {
  const text = (value ?? '').toLowerCase();
  if (!text) return 'unset';
  if (text.includes('capital') || text.includes('capex')) return 'capex';
  if (text.includes('cost') || text.includes('opex') || text.includes('expense')) return 'opex';
  return 'other';
};

export function ticketExportFile(rows: TicketRow[], stamp: string) {
  return {
    name: `trackline-team-tickets-${stamp}`,
    rows: [
      ['Ticket', 'Summary', 'Issue type', 'Status', 'Parent', 'Work type', 'Cost/Capitalized', 'Estimate (h)', 'Logged in period (h)', 'Total logged (h)', 'Logged by'],
      ...[...rows].sort((a, b) => b.periodHours - a.periodHours).map(row => [
        row.key, row.summary, row.issueType ?? '', row.status ?? '', row.parentKey ?? '', row.workType ?? '', row.costType ?? '',
        row.originalEstimateSeconds !== undefined ? hoursNumber(row.originalEstimateSeconds / 3600) : '',
        hoursNumber(row.periodHours),
        row.timeSpentSeconds !== undefined ? hoursNumber(row.timeSpentSeconds / 3600) : '',
        row.people.map(person => `${person.name} (${hoursNumber(person.hours)}h)`).join('; '),
      ]),
    ] as (string | number)[][],
  };
}

function TypeIcon({ row }: { row: TeamIssue }) {
  const [hasFailed, setHasFailed] = useState(false);
  const name = row.issueType ?? 'Issue';
  return row.issueTypeIcon && !hasFailed
    ? <img className="ticket-type" src={row.issueTypeIcon} alt={name} title={name} width={16} height={16} onError={() => setHasFailed(true)} />
    : <span className="ticket-type fallback" role="img" aria-label={name} title={name} />;
}

function PeopleStack({ people }: { people: TicketPerson[] }) {
  const summary = people.map(person => `${person.name} ${formatHours(person.hours)}`).join(', ');
  return <span className="people-stack" title={summary} aria-label={summary}>
    {people.slice(0, 4).map(person => <Avatar key={person.accountId} name={person.name} url={person.avatarUrl} size={24} />)}
    {people.length > 4 && <span className="people-more">+{people.length - 4}</span>}
    {people.length === 1 && <span className="people-name">{people[0].name}</span>}
  </span>;
}

function FieldValue({ value, tone }: { value?: string; tone?: string }) {
  return value ? <span className={`field-chip${tone ? ` ${tone}` : ''}`}>{value}</span> : <span className="field-unset">{notSet}</span>;
}

type TicketTableProps = { rows: TicketRow[]; isLoading: boolean; periodLabel: string; fieldsMissing: { workType: boolean; cost: boolean } };

export function TicketTable({ rows, isLoading, periodLabel, fieldsMissing }: TicketTableProps) {
  const [query, setQuery] = useState('');
  const [workTypeFilter, setWorkTypeFilter] = useState('all');
  const [costFilter, setCostFilter] = useState('all');
  const [sort, setSort] = useState<{ key: SortKey; direction: 1 | -1 }>({ key: 'period', direction: -1 });
  const [detail, setDetail] = useState<TicketRow | null>(null);

  useEffect(() => {
    if (!detail) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setDetail(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [detail]);

  const workTypes = useMemo(() => [...new Set(rows.map(row => row.workType ?? notSet))].sort(), [rows]);
  const costTypes = useMemo(() => [...new Set(rows.map(row => row.costType ?? notSet))].sort(), [rows]);

  const visibleRows = useMemo(() => {
    const text = query.trim().toLowerCase();
    const value = (row: TicketRow): string | number => {
      switch (sort.key) {
        case 'ticket': return row.key;
        case 'workType': return row.workType ?? '~';
        case 'cost': return row.costType ?? '~';
        case 'estimate': return row.originalEstimateSeconds ?? -1;
        case 'total': return row.timeSpentSeconds ?? -1;
        default: return row.periodHours;
      }
    };
    return rows
      .filter(row => !text || row.key.toLowerCase().includes(text) || row.summary.toLowerCase().includes(text) || row.people.some(person => person.name.toLowerCase().includes(text)))
      .filter(row => workTypeFilter === 'all' || (row.workType ?? notSet) === workTypeFilter)
      .filter(row => costFilter === 'all' || (row.costType ?? notSet) === costFilter)
      .sort((a, b) => {
        const left = value(a); const right = value(b);
        const order = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true });
        return order * sort.direction || b.periodHours - a.periodHours;
      });
  }, [rows, query, workTypeFilter, costFilter, sort]);

  const totalHours = visibleRows.reduce((sum, row) => sum + row.periodHours, 0);
  const splitBy = (pick: (row: TicketRow) => string | undefined) => [...visibleRows.reduce((groups, row) => groups.set(pick(row) ?? notSet, (groups.get(pick(row) ?? notSet) ?? 0) + row.periodHours), new Map<string, number>())]
    .map(([label, hours]) => ({ label, hours })).sort((a, b) => b.hours - a.hours);
  const costSplit = splitBy(row => row.costType);
  const workTypeSplit = splitBy(row => row.workType);
  const percent = (hours: number) => totalHours ? Math.round(hours / totalHours * 100) : 0;

  const header = (key: SortKey, label: string, className = '') => {
    const isActive = sort.key === key;
    return <th scope="col" className={className} aria-sort={isActive ? (sort.direction === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => setSort(current => ({ key, direction: current.key === key ? (current.direction === 1 ? -1 : 1) : key === 'ticket' || key === 'workType' || key === 'cost' ? 1 : -1 }))}>
        {label}{isActive && (sort.direction === 1 ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />)}
      </button>
    </th>;
  };

  const detailEstimate = hoursOf(detail?.originalEstimateSeconds);
  const detailTotal = hoursOf(detail?.timeSpentSeconds);

  return <>
    {(fieldsMissing.workType || fieldsMissing.cost) && <p className="ticket-hint">{fieldsMissing.workType && fieldsMissing.cost ? 'Work type and Cost/Capitalized fields are' : fieldsMissing.workType ? 'The Work type field is' : 'The Cost/Capitalized field is'} not mapped. Choose them in Settings → Jira fields.</p>}

    <div className="ticket-summary" aria-label={`Hours by cost type and work type for ${periodLabel}`}>
      <div className="split">
        <span className="split-title">Cost / capitalized <b>{formatHours(totalHours)}</b></span>
        <div className="split-bar" aria-hidden="true">{costSplit.map(item => <i key={item.label} className={`seg ${costTone(item.label === notSet ? undefined : item.label)}`} style={{ flexGrow: item.hours || 0.0001 }} />)}</div>
        <ul className="split-legend">{costSplit.map(item => <li key={item.label}><i className={`dot ${costTone(item.label === notSet ? undefined : item.label)}`} />{item.label}<b>{formatHours(item.hours)}</b><small>{percent(item.hours)}%</small></li>)}</ul>
      </div>
      <div className="split">
        <span className="split-title">Work type</span>
        <ul className="split-list">{workTypeSplit.map(item => <li key={item.label}><span>{item.label}</span><span className="split-track"><i style={{ width: `${percent(item.hours)}%` }} /></span><b>{formatHours(item.hours)}</b></li>)}</ul>
      </div>
    </div>

    <div className="ticket-filters">
      <label className="ticket-search"><Search size={14} aria-hidden="true" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter by ticket, summary or person" aria-label="Filter tickets" /></label>
      <label className="ticket-select"><span>Work type</span><select value={workTypeFilter} onChange={event => setWorkTypeFilter(event.target.value)}><option value="all">All</option>{workTypes.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="ticket-select"><span>Cost/Capitalized</span><select value={costFilter} onChange={event => setCostFilter(event.target.value)}><option value="all">All</option>{costTypes.map(value => <option key={value}>{value}</option>)}</select></label>
      <span className="ticket-count">{visibleRows.length} of {rows.length} tickets</span>
    </div>

    <div className="team-grid-wrap ticket-wrap">
      <table className="ticket-table">
        <thead><tr>
          {header('ticket', 'Ticket', 'ticket-col')}
          {header('workType', 'Work type', 'worktype-col')}
          {header('cost', 'Cost/Capitalized', 'cost-col')}
          {header('estimate', 'Estimate', 'num')}
          {header('period', 'Logged', 'num')}
          {header('total', 'Total logged')}
          <th scope="col">Logged by</th>
        </tr></thead>
        <tbody>{visibleRows.map(row => {
          const estimate = hoursOf(row.originalEstimateSeconds);
          const total = hoursOf(row.timeSpentSeconds);
          const over = estimate !== undefined && total !== undefined && total - estimate > 0.01 ? total - estimate : 0;
          return <tr key={row.key}>
            <th scope="row" className="ticket-col"><button type="button" className="ticket-cell" onClick={() => setDetail(row)}>
              <TypeIcon row={row} />
              <span><span className="ticket-line"><b>{row.key}</b><strong>{row.summary}</strong></span><small>{[row.status, row.parentKey && `in ${row.parentKey}`].filter(Boolean).join(' · ')}</small></span>
            </button></th>
            <td className="worktype-col"><FieldValue value={row.workType} /></td>
            <td className="cost-col"><FieldValue value={row.costType} tone={costTone(row.costType)} /></td>
            <td className="num">{estimate !== undefined ? formatHours(estimate) : <span className="field-unset">—</span>}</td>
            <td className="num strong">{formatHours(row.periodHours)}</td>
            <td><div className="spent">
              <span>{total !== undefined ? formatHours(total) : '—'}{estimate !== undefined && <small> of {formatHours(estimate)}</small>}</span>
              {estimate !== undefined && total !== undefined && <span className="spent-meter" aria-hidden="true"><i className={over ? 'over' : ''} style={{ width: `${Math.min(100, estimate ? total / estimate * 100 : 100)}%` }} /></span>}
              {over > 0 && <small className="over-text">{formatHours(over)} over</small>}
            </div></td>
            <td><PeopleStack people={row.people} /></td>
          </tr>;
        })}</tbody>
        <tfoot><tr>
          <th scope="row" className="ticket-col">{visibleRows.length} tickets</th>
          <td colSpan={2} />
          <td className="num">{formatHours(visibleRows.reduce((sum, row) => sum + (hoursOf(row.originalEstimateSeconds) ?? 0), 0))}</td>
          <td className="num strong">{formatHours(totalHours)}</td>
          <td colSpan={2} />
        </tr></tfoot>
      </table>
      {!visibleRows.length && !isLoading && <p className="ticket-empty">No tickets match these filters.</p>}
      {isLoading && <div className="calendar-loading"><span />Loading tickets</div>}
    </div>

    {detail && <div className="popover-backdrop" onClick={() => setDetail(null)}>
      <section className="team-detail ticket-detail" role="dialog" aria-modal="true" aria-labelledby="ticket-detail-title" onClick={event => event.stopPropagation()}>
        <button className="close" onClick={() => setDetail(null)} aria-label="Close"><X size={18} /></button>
        <div className="ticket-detail-head"><TypeIcon row={detail} /><div><b>{detail.key}</b><h2 id="ticket-detail-title">{detail.summary}</h2><p>{[detail.issueType, detail.status, detail.parentKey && `in ${detail.parentKey}${detail.parentSummary ? ` · ${detail.parentSummary}` : ''}`].filter(Boolean).join(' · ')}</p></div></div>
        <dl className="ticket-facts">
          <div><dt>Work type</dt><dd><FieldValue value={detail.workType} /></dd></div>
          <div><dt>Cost/Capitalized</dt><dd><FieldValue value={detail.costType} tone={costTone(detail.costType)} /></dd></div>
          <div><dt>Estimate</dt><dd>{detailEstimate !== undefined ? formatHours(detailEstimate) : '—'}</dd></div>
          <div><dt>Total logged</dt><dd>{detailTotal !== undefined ? formatHours(detailTotal) : '—'}</dd></div>
          <div><dt>Logged in {periodLabel}</dt><dd>{formatHours(detail.periodHours)}</dd></div>
          <div><dt>{detailEstimate !== undefined && detailTotal !== undefined && detailTotal > detailEstimate ? 'Over estimate' : 'Remaining'}</dt><dd>{detailEstimate !== undefined && detailTotal !== undefined ? formatHours(Math.abs(detailEstimate - detailTotal)) : '—'}</dd></div>
        </dl>
        <ul className="team-detail-list">{detail.people.map(person => <li key={person.accountId}>
          <div className="ticket-person"><Avatar name={person.name} url={person.avatarUrl} size={22} /><span>{person.name}</span><em>{formatHours(person.hours)}</em></div>
          <small>{detail.logs.filter(log => log.authorId === person.accountId).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map(log => `${new Date(`${log.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${formatHours(log.durationMinutes / 60)}${log.description ? ` (${log.description})` : ''}`).join(' · ')}</small>
        </li>)}</ul>
        <button type="button" className="open-issue ticket-open" onClick={() => { invoke('open_issue', { issueKey: detail.key }).catch(() => undefined); }}>Open in Jira <ExternalLink size={15} /></button>
      </section>
    </div>}
  </>;
}
