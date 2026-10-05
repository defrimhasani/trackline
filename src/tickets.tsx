import { Fragment, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowDown, ArrowUp, ExternalLink, Plus, Search, X } from 'lucide-react';
import { Avatar, type TeamWorklog } from './team';
import { formatHours, hoursNumber, readableError } from './utils';

export type TeamIssue = {
  key: string; summary: string; project: string; issueType?: string; issueTypeIcon?: string;
  status?: string; statusCategory?: string; parentKey?: string; parentSummary?: string;
  originalEstimateSeconds?: number; timeSpentSeconds?: number; fieldValues?: Record<string, string>;
};
export type JiraField = { id: string; name: string; fieldType: string; custom: boolean };
export type TicketField = { id: string; name: string };
type TicketPerson = { accountId: string; name: string; avatarUrl?: string; hours: number };
export type TicketRow = TeamIssue & { periodHours: number; people: TicketPerson[]; logs: TeamWorklog[] };
type SortKey = 'ticket' | 'estimate' | 'period' | 'total' | `field:${string}`;
const maxTicketFields = 20;

const storageKey = 'trackline.ticketFields';
const notSet = 'Not set';
const hoursOf = (seconds?: number) => seconds === undefined || seconds === null ? undefined : seconds / 3600;
const fieldValue = (row: TeamIssue, field: TicketField) => row.fieldValues?.[field.id];

function readTicketFields(): TicketField[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if (Array.isArray(saved.fields)) return saved.fields.filter((field: TicketField) => typeof field?.id === 'string');
    // Earlier versions stored a fixed Work type and Cost/Capitalized mapping; carry those over as regular fields.
    const legacy = [saved.workTypeField, saved.costField].filter((id): id is string => typeof id === 'string').map(id => ({ id, name: id }));
    const extra: TicketField[] = Array.isArray(saved.extraFields) ? saved.extraFields : [];
    return [...legacy, ...extra].filter((field, index, list) => list.findIndex(item => item.id === field.id) === index).slice(0, maxTicketFields);
  } catch { return []; }
}

export function useTicketFields(enabled: boolean) {
  const [saved, setFields] = useState<TicketField[]>(readTicketFields);
  const [options, setOptions] = useState<JiraField[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify({ fields: saved })); }, [saved]);
  useEffect(() => {
    if (!enabled) return;
    let isCurrent = true;
    invoke<JiraField[]>('list_fields')
      .then(result => { if (isCurrent) { setOptions(result); setError(''); } })
      .catch(reason => { if (isCurrent) setError(readableError(reason)); });
    return () => { isCurrent = false; };
  }, [enabled]);
  const fields = useMemo(() => saved.map(field => ({ id: field.id, name: options.find(option => option.id === field.id)?.name ?? field.name })), [saved, options]);
  return { fields, setFields, options, error };
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

export function ticketExportFile(rows: TicketRow[], stamp: string, fields: TicketField[] = []) {
  const sorted = [...rows].sort((a, b) => b.periodHours - a.periodHours);
  const totalHours = sorted.reduce((sum, row) => sum + row.periodHours, 0);
  return {
    name: `trackline-team-tickets-${stamp}`,
    rows: [
      ['Ticket', 'Summary', 'Issue type', 'Status', 'Parent', ...fields.map(field => field.name), 'Logged in period (h)', 'Logged by'],
      ...sorted.map(row => [
        row.key, row.summary, row.issueType ?? '', row.status ?? '', row.parentKey ?? '',
        ...fields.map(field => fieldValue(row, field) ?? ''),
        hoursNumber(row.periodHours),
        row.people.map(person => `${person.name} (${hoursNumber(person.hours)}h)`).join('; '),
      ]),
      ['Total', `${sorted.length} ${sorted.length === 1 ? 'ticket' : 'tickets'}`, '', '', '', ...fields.map(() => ''), hoursNumber(totalHours), ''],
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

function FieldValue({ value }: { value?: string }) {
  return value ? <span className="field-chip">{value}</span> : <span className="field-unset">{notSet}</span>;
}

type TicketTableProps = { rows: TicketRow[]; isLoading: boolean; periodLabel: string; fields: TicketField[] };

export function TicketTable({ rows, isLoading, periodLabel, fields }: TicketTableProps) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ key: SortKey; direction: 1 | -1 }>({ key: 'period', direction: -1 });
  const [detail, setDetail] = useState<TicketRow | null>(null);

  useEffect(() => {
    if (!detail) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setDetail(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [detail]);

  const valuesByField = useMemo(() => new Map(fields.map(field => [field.id, [...new Set(rows.map(row => fieldValue(row, field) ?? notSet))].sort()])), [rows, fields]);

  const visibleRows = useMemo(() => {
    const text = query.trim().toLowerCase();
    const value = (row: TicketRow): string | number => {
      switch (sort.key) {
        case 'ticket': return row.key;
        case 'estimate': return row.originalEstimateSeconds ?? -1;
        case 'total': return row.timeSpentSeconds ?? -1;
        case 'period': return row.periodHours;
        default: return row.fieldValues?.[sort.key.slice(6)] ?? '~';
      }
    };
    return rows
      .filter(row => !text || row.key.toLowerCase().includes(text) || row.summary.toLowerCase().includes(text) || row.people.some(person => person.name.toLowerCase().includes(text)))
      .filter(row => fields.every(field => !filters[field.id] || filters[field.id] === 'all' || (fieldValue(row, field) ?? notSet) === filters[field.id]))
      .sort((a, b) => {
        const left = value(a); const right = value(b);
        const order = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true });
        return order * sort.direction || b.periodHours - a.periodHours;
      });
  }, [rows, query, filters, fields, sort]);

  const totalHours = visibleRows.reduce((sum, row) => sum + row.periodHours, 0);
  const splitBy = (field: TicketField) => [...visibleRows.reduce((groups, row) => { const label = fieldValue(row, field) ?? notSet; return groups.set(label, (groups.get(label) ?? 0) + row.periodHours); }, new Map<string, number>())]
    .map(([label, hours]) => ({ label, hours })).sort((a, b) => b.hours - a.hours);
  const percent = (hours: number) => totalHours ? Math.round(hours / totalHours * 100) : 0;

  const header = (key: SortKey, label: string, className = '') => {
    const isActive = sort.key === key;
    return <th scope="col" className={className} aria-sort={isActive ? (sort.direction === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => setSort(current => ({ key, direction: current.key === key ? (current.direction === 1 ? -1 : 1) : key === 'ticket' || key.startsWith('field:') ? 1 : -1 }))}>
        {label}{isActive && (sort.direction === 1 ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />)}
      </button>
    </th>;
  };

  const detailEstimate = hoursOf(detail?.originalEstimateSeconds);
  const detailTotal = hoursOf(detail?.timeSpentSeconds);

  return <>
    {!fields.length && <p className="ticket-hint">No Jira fields configured. Add the fields you want to see in Settings → Jira fields.</p>}

    {fields.length > 0 && <div className="ticket-summary" aria-label={`Hours by field for ${periodLabel}`}>
      {fields.map(field => <div className="split" key={field.id}>
        <span className="split-title">{field.name} <b>{formatHours(totalHours)}</b></span>
        <ul className="split-list">{splitBy(field).map(item => <li key={item.label} className={item.label === notSet ? 'is-unset' : ''}>
          <span className="split-row"><span className={`split-label${item.label === notSet ? ' unset' : ''}`}>{item.label}</span><b>{formatHours(item.hours)}</b><small>{percent(item.hours)}%</small></span>
          <span className="split-track" aria-hidden="true"><i style={{ width: `${percent(item.hours)}%` }} /></span>
        </li>)}</ul>
      </div>)}
    </div>}

    <div className="ticket-filters">
      <label className="ticket-search"><Search size={14} aria-hidden="true" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter by ticket, summary or person" aria-label="Filter tickets" /></label>
      {fields.map(field => <label className="ticket-select" key={field.id}><span>{field.name}</span><select value={filters[field.id] ?? 'all'} onChange={event => setFilters(current => ({ ...current, [field.id]: event.target.value }))}><option value="all">All</option>{(valuesByField.get(field.id) ?? []).map(value => <option key={value}>{value}</option>)}</select></label>)}
      <span className="ticket-count">{visibleRows.length} of {rows.length} tickets</span>
    </div>

    <div className="team-grid-wrap ticket-wrap">
      <table className="ticket-table">
        <thead><tr>
          {header('ticket', 'Ticket', 'ticket-col')}
          {fields.map(field => <Fragment key={field.id}>{header(`field:${field.id}`, field.name, 'field-col')}</Fragment>)}
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
            {fields.map(field => <td className="field-col" key={field.id}><FieldValue value={fieldValue(row, field)} /></td>)}
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
          {fields.length > 0 && <td colSpan={fields.length} />}
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
          {fields.map(field => <div key={field.id}><dt>{field.name}</dt><dd><FieldValue value={fieldValue(detail, field)} /></dd></div>)}
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

type TicketFieldListProps = { fields: TicketField[]; options: JiraField[]; onChange: (fields: TicketField[]) => void };

export function TicketFieldList({ fields, options, onChange }: TicketFieldListProps) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [active, setActive] = useState(0);
  const isFull = fields.length >= maxTicketFields;
  const matches = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return options
      .filter(option => !fields.some(field => field.id === option.id))
      .filter(option => terms.every(term => `${option.name} ${option.id}`.toLowerCase().includes(term)));
  }, [options, fields, query]);
  useEffect(() => { setActive(0); }, [query]);
  const add = (option?: JiraField) => {
    if (!option || isFull) return;
    onChange([...fields, { id: option.id, name: option.name }]);
    setQuery('');
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setIsOpen(true); setActive(index => Math.min(index + 1, matches.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); if (isOpen) add(matches[active]); }
    else if (event.key === 'Escape' && isOpen) { event.preventDefault(); event.stopPropagation(); setIsOpen(false); }
  };
  const move = (index: number, offset: number) => {
    const next = [...fields];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    onChange(next);
  };
  const showList = isOpen && !isFull;
  return <div className="jira-fields">
    {fields.length ? <ul className="jira-field-list" aria-label="Configured Jira fields">{fields.map((field, index) => <li key={field.id}>
      <span><b>{field.name}</b><small>{field.id}</small></span>
      <button type="button" className="icon-mini" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${field.name} up`} title="Move up"><ArrowUp size={14} /></button>
      <button type="button" className="icon-mini" onClick={() => move(index, 1)} disabled={index === fields.length - 1} aria-label={`Move ${field.name} down`} title="Move down"><ArrowDown size={14} /></button>
      <button type="button" className="icon-mini" onClick={() => onChange(fields.filter(item => item.id !== field.id))} aria-label={`Remove ${field.name}`} title="Remove"><X size={14} /></button>
    </li>)}</ul> : <p className="setting-hint">No fields yet. Search below to add one.</p>}
    <div className="jira-field-add">
      <label className="jira-field-search"><Plus size={14} aria-hidden="true" /><input value={query} disabled={isFull || !options.length}
        onChange={event => { setQuery(event.target.value); setIsOpen(true); }} onFocus={() => setIsOpen(true)} onBlur={() => setIsOpen(false)} onKeyDown={onKeyDown}
        placeholder={isFull ? `Up to ${maxTicketFields} fields` : 'Search fields to add…'} role="combobox" aria-expanded={showList} aria-controls="jira-field-options" aria-autocomplete="list" aria-label="Search fields to add"
        aria-activedescendant={showList && matches[active] ? `jira-field-option-${matches[active].id}` : undefined} spellCheck={false} autoComplete="off" /></label>
      {showList && <ul className="jira-field-options" id="jira-field-options" role="listbox" aria-label="Jira fields">
        {matches.length ? matches.map((option, index) => <li key={option.id} id={`jira-field-option-${option.id}`} role="option" aria-selected={index === active}
          className={index === active ? 'active' : ''} onMouseDown={event => { event.preventDefault(); add(option); }} onMouseEnter={() => setActive(index)}>
          <b>{option.name}</b><small>{option.custom ? 'Custom' : 'Jira'}</small>
        </li>) : <li className="empty" role="presentation">No matching fields</li>}
      </ul>}
    </div>
    <p className="setting-hint">Each field becomes a column, filter and breakdown in the Tickets view, and a column in the tickets CSV.</p>
  </div>;
}
