import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FolderKanban, Pin, Plus, Search, UserRound, X } from 'lucide-react';
import { formatHours, hoursNumber, isWeekend, localDate, readableError, weekdayLabels } from './utils';
import { TicketTable, buildTicketRows, ticketExportFile, type TeamIssue } from './tickets';

export type TeamProject = { key: string; name: string; avatarUrl?: string };
export type TeamPerson = { accountId: string; displayName: string; avatarUrl?: string };
export type TeamScope = { projects: TeamProject[]; people: TeamPerson[] };
export type TeamWorklog = { id: string; date: string; startedAt: string; issue: string; summary: string; durationMinutes: number; description: string; authorId: string; authorName: string; authorAvatar?: string };
export type TeamRow = { accountId: string; name: string; avatarUrl?: string; pinned: boolean; hoursByDate: Map<string, number>; logsByDate: Map<string, TeamWorklog[]>; total: number };
type Range = { start: string; end: string };

const scopeStorageKey = 'trackline.team.scope';

export function useTeamScope() {
  const [scope, setScope] = useState<TeamScope>(() => {
    try { const saved = JSON.parse(localStorage.getItem(scopeStorageKey) ?? '{}'); return { projects: saved.projects ?? [], people: saved.people ?? [] }; }
    catch { return { projects: [], people: [] }; }
  });
  useEffect(() => { localStorage.setItem(scopeStorageKey, JSON.stringify(scope)); }, [scope]);
  return [scope, setScope] as const;
}

export function useTeamWorklogs(scope: TeamScope, range: Range, enabled: boolean, fields: { workTypeField?: string; costField?: string } = {}) {
  const cache = useRef(new Map<string, { worklogs: TeamWorklog[]; issues: TeamIssue[] }>());
  const [worklogs, setWorklogs] = useState<TeamWorklog[]>([]);
  const [issues, setIssues] = useState<TeamIssue[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const shownKey = useRef('');
  const projectKeys = scope.projects.map(project => project.key);
  const accountIds = scope.people.map(person => person.accountId);
  const scopeKey = `${projectKeys.join(',')}|${accountIds.join(',')}|${fields.workTypeField ?? ''}|${fields.costField ?? ''}`;

  useEffect(() => {
    if (!enabled) return;
    const cacheKey = `${scopeKey}|${range.start}|${range.end}`;
    const cached = cache.current.get(cacheKey);
    if (cached) { shownKey.current = cacheKey; setWorklogs(cached.worklogs); setIssues(cached.issues); setIsLoading(false); setError(''); return; }
    if (!projectKeys.length && !accountIds.length) { setWorklogs([]); setIssues([]); setIsLoading(false); setError(''); return; }
    let isCurrent = true;
    setIsLoading(true); setError('');
    if (shownKey.current !== cacheKey) { setWorklogs([]); setIssues([]); }
    shownKey.current = cacheKey;
    invoke<{ worklogs: TeamWorklog[]; issues: TeamIssue[] }>('get_team_worklogs', {
      projectKeys, accountIds, startDate: range.start, endDate: range.end,
      startedAfter: new Date(`${range.start}T00:00:00`).getTime() - 86_400_000, startedBefore: new Date(`${range.end}T00:00:00`).getTime() + 86_400_000,
      workTypeField: fields.workTypeField ?? null, costField: fields.costField ?? null,
    })
      .then(result => { cache.current.set(cacheKey, result); if (isCurrent) { setWorklogs(result.worklogs); setIssues(result.issues); setSyncedAt(new Date()); } })
      .catch(reason => { if (isCurrent) setError(readableError(reason)); })
      .finally(() => { if (isCurrent) setIsLoading(false); });
    return () => { isCurrent = false; };
  }, [enabled, scopeKey, range.start, range.end, reloadKey]);

  const refresh = () => { cache.current.clear(); setReloadKey(key => key + 1); };
  return { worklogs, issues, isLoading, error, refresh, syncedAt };
}

export function buildTeamRows(worklogs: TeamWorklog[], people: TeamPerson[]): TeamRow[] {
  const rows = new Map<string, TeamRow>();
  const rowFor = (accountId: string, name: string, avatarUrl?: string) => {
    const existing = rows.get(accountId);
    if (existing) return existing;
    const row: TeamRow = { accountId, name, avatarUrl, pinned: false, hoursByDate: new Map(), logsByDate: new Map(), total: 0 };
    rows.set(accountId, row);
    return row;
  };
  people.forEach(person => { rowFor(person.accountId, person.displayName, person.avatarUrl).pinned = true; });
  worklogs.forEach(log => {
    const row = rowFor(log.authorId, log.authorName, log.authorAvatar);
    const hours = log.durationMinutes / 60;
    row.hoursByDate.set(log.date, (row.hoursByDate.get(log.date) ?? 0) + hours);
    row.logsByDate.set(log.date, [...(row.logsByDate.get(log.date) ?? []), log]);
    row.total += hours;
  });
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const missingHours = (hours: number, date: Date, todayValue: string, workdayHours: number) => {
  if (isWeekend(date) || localDate(date) > todayValue) return 0;
  const missing = workdayHours - hours;
  return missing > 0.01 ? missing : 0;
};

export function teamExportFiles(rows: TeamRow[], worklogs: TeamWorklog[], dates: Date[], stamp: string, issues: TeamIssue[] = []) {
  const values = dates.map(localDate);
  const summary: (string | number)[][] = [
    ['Person', ...values, 'Total'],
    ...rows.map(row => [row.name, ...values.map(value => hoursNumber(row.hoursByDate.get(value) ?? 0)), hoursNumber(row.total)]),
    ['Day total', ...values.map(value => hoursNumber(rows.reduce((sum, row) => sum + (row.hoursByDate.get(value) ?? 0), 0))), hoursNumber(rows.reduce((sum, row) => sum + row.total, 0))],
  ];
  const details: (string | number)[][] = [
    ['Date', 'Start', 'Person', 'Issue', 'Summary', 'Hours', 'Description'],
    ...[...worklogs].sort((a, b) => a.date.localeCompare(b.date) || a.authorName.localeCompare(b.authorName) || a.startedAt.localeCompare(b.startedAt))
      .map(log => [log.date, log.startedAt.slice(11, 16), log.authorName, log.issue, log.summary, hoursNumber(log.durationMinutes / 60), log.description]),
  ];
  return [{ name: `trackline-team-summary-${stamp}`, rows: summary }, { name: `trackline-team-worklogs-${stamp}`, rows: details }, ticketExportFile(buildTicketRows(issues, worklogs), stamp)];
}

export function Avatar({ name, url, size = 24 }: { name: string; url?: string; size?: number }) {
  const [hasFailed, setHasFailed] = useState(false);
  const initials = name.split(/[\s.]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('');
  const style = { width: size, height: size, fontSize: Math.round(size * 0.38) };
  return url && !hasFailed ? <img className="person-avatar" src={url} alt="" style={style} onError={() => setHasFailed(true)} /> : <span className="person-avatar initials" style={style} aria-hidden="true">{initials}</span>;
}

type PickerProps<T> = {
  label: string; placeholder: string; search: (query: string) => Promise<T[]>; optionKey: (item: T) => string;
  renderOption: (item: T) => ReactNode; onSelect: (item: T) => void; emptyText: (query: string) => string;
};

function ScopePicker<T>({ label, placeholder, search, optionKey, renderOption, onSelect, emptyText }: PickerProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<T[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    let isCurrent = true;
    setIsSearching(true); setError('');
    const timer = window.setTimeout(() => {
      search(query.trim())
        .then(items => { if (isCurrent) setResults(items); })
        .catch(reason => { if (isCurrent) { setResults([]); setError(readableError(reason)); } })
        .finally(() => { if (isCurrent) setIsSearching(false); });
    }, 250);
    return () => { isCurrent = false; window.clearTimeout(timer); };
  }, [isOpen, query]);

  useEffect(() => {
    if (!isOpen) return;
    const close = (event: MouseEvent) => { if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [isOpen]);

  return <div className="scope-picker" ref={containerRef}>
    <button type="button" className="scope-add" onClick={() => setIsOpen(value => !value)} aria-expanded={isOpen}><Plus size={14} />{label}</button>
    {isOpen && <div className="scope-popover">
      <div className="scope-search"><Search size={14} aria-hidden="true" /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setIsOpen(false); }} placeholder={placeholder} aria-label={placeholder} /></div>
      <div className="scope-results" role="listbox" aria-label={label}>
        {results.map(item => <button type="button" role="option" aria-selected="false" key={optionKey(item)} onClick={() => { onSelect(item); setIsOpen(false); setQuery(''); }}>{renderOption(item)}</button>)}
        {!results.length && <p>{isSearching ? 'Searching Jira…' : error || emptyText(query.trim())}</p>}
      </div>
    </div>}
  </div>;
}

type TeamWorklogsProps = {
  scope: TeamScope; setScope: (update: (current: TeamScope) => TeamScope) => void;
  worklogs: TeamWorklog[]; rows: TeamRow[]; isLoading: boolean; error: string; onRefresh: () => void;
  periodDays: Date[]; periodLabel: string; calendarMode: 'week' | 'month'; onModeChange: (mode: 'week' | 'month') => void;
  workdayHours: number; todayValue: string;
  focusIncomplete: boolean; onFocusChange: (value: boolean) => void;
  hideWeekends: boolean; onHideWeekendsChange: (value: boolean) => void;
  issues: TeamIssue[]; fieldsMissing: { workType: boolean; cost: boolean };
};

export function TeamWorklogs(props: TeamWorklogsProps) {
  const { scope, setScope, rows, isLoading, error, onRefresh, periodDays, periodLabel, calendarMode, workdayHours, todayValue, focusIncomplete, hideWeekends } = props;
  const [detail, setDetail] = useState<{ row: TeamRow; date: Date } | null>(null);
  const [groupBy, setGroupBy] = useState<'people' | 'tickets'>(() => localStorage.getItem('trackline.team.groupBy') === 'tickets' ? 'tickets' : 'people');
  useEffect(() => { localStorage.setItem('trackline.team.groupBy', groupBy); }, [groupBy]);
  const ticketRows = useMemo(() => buildTicketRows(props.issues, props.worklogs), [props.issues, props.worklogs]);
  const isTickets = groupBy === 'tickets';
  const hasScope = scope.projects.length > 0 || scope.people.length > 0;
  const showFocus = focusIncomplete && !isLoading && !error && hasScope;
  const missingFor = (row: TeamRow, date: Date) => missingHours(row.hoursByDate.get(localDate(date)) ?? 0, date, todayValue, workdayHours);
  const incompleteCount = showFocus ? rows.reduce((sum, row) => sum + periodDays.filter(date => missingFor(row, date) > 0).length, 0) : 0;
  const dayTotals = periodDays.map(date => rows.reduce((sum, row) => sum + (row.hoursByDate.get(localDate(date)) ?? 0), 0));
  const grandTotal = rows.reduce((sum, row) => sum + row.total, 0);
  const longDate = (date: Date) => date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  useEffect(() => {
    if (!detail) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setDetail(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [detail]);

  const summaryText = !hasScope ? 'Choose Jira projects or pin people to build your team view.'
    : isLoading ? 'Loading team worklogs…'
    : error ? error
    : isTickets ? `${ticketRows.length} ${ticketRows.length === 1 ? 'ticket' : 'tickets'} · ${formatHours(grandTotal)} logged in ${periodLabel}`
    : `${rows.length} ${rows.length === 1 ? 'person' : 'people'} · ${formatHours(grandTotal)} logged in ${periodLabel}${showFocus ? ` · ${incompleteCount} incomplete ${incompleteCount === 1 ? 'day' : 'days'}` : ''}`;

  const detailHours = detail ? detail.row.hoursByDate.get(localDate(detail.date)) ?? 0 : 0;
  const detailMissing = detail ? missingFor(detail.row, detail.date) : 0;
  const detailLogs = detail ? detail.row.logsByDate.get(localDate(detail.date)) ?? [] : [];

  return <section className="team-page" aria-labelledby="team-title">
    <div className="calendar-heading">
      <div><h1 id="team-title">Team worklogs</h1><p>{summaryText}</p></div>
      <div className="calendar-controls">
        <div className="view-tabs" aria-label="Group worklogs by">
          <button className={!isTickets ? 'selected' : ''} aria-pressed={!isTickets} onClick={() => setGroupBy('people')}>People</button>
          <button className={isTickets ? 'selected' : ''} aria-pressed={isTickets} onClick={() => setGroupBy('tickets')}>Tickets</button>
        </div>
        {!isTickets && <div className="calendar-options">
          <label className="calendar-option"><button type="button" role="switch" aria-checked={focusIncomplete} className={`toggle${focusIncomplete ? ' on' : ''}`} onClick={() => props.onFocusChange(!focusIncomplete)}><i /></button>Focus on incomplete days{showFocus && <b aria-label={`${incompleteCount} incomplete days`}>{incompleteCount}</b>}</label>
          <label className="calendar-option"><button type="button" role="switch" aria-checked={hideWeekends} className={`toggle${hideWeekends ? ' on' : ''}`} onClick={() => props.onHideWeekendsChange(!hideWeekends)}><i /></button>Hide weekends</label>
        </div>}
        <div className="view-tabs">
          <button className={calendarMode === 'week' ? 'selected' : ''} aria-pressed={calendarMode === 'week'} onClick={() => props.onModeChange('week')}>Week</button>
          <button className={calendarMode === 'month' ? 'selected' : ''} aria-pressed={calendarMode === 'month'} onClick={() => props.onModeChange('month')}>Month</button>
        </div>
      </div>
    </div>

    <div className="team-scope">
      <div className="scope-group">
        <span className="scope-label">Projects</span>
        {scope.projects.map(project => <span className="scope-chip" key={project.key}>{project.avatarUrl ? <img src={project.avatarUrl} alt="" /> : <FolderKanban size={14} aria-hidden="true" />}<span>{project.key}<small>{project.name}</small></span><button type="button" onClick={() => setScope(current => ({ ...current, projects: current.projects.filter(item => item.key !== project.key) }))} aria-label={`Remove ${project.name}`}><X size={13} /></button></span>)}
        <ScopePicker<TeamProject> label="Add project" placeholder="Search Jira projects" search={query => invoke<TeamProject[]>('search_projects', { query })} optionKey={project => project.key}
          renderOption={project => <>{project.avatarUrl ? <img src={project.avatarUrl} alt="" /> : <FolderKanban size={16} aria-hidden="true" />}<b>{project.key}</b><span>{project.name}</span></>}
          onSelect={project => setScope(current => current.projects.some(item => item.key === project.key) ? current : { ...current, projects: [...current.projects, project] })}
          emptyText={() => 'No matching projects.'} />
      </div>
      <div className="scope-group">
        <span className="scope-label">Pinned people</span>
        {scope.people.map(person => <span className="scope-chip" key={person.accountId}><Avatar name={person.displayName} url={person.avatarUrl} size={18} /><span>{person.displayName}</span><button type="button" onClick={() => setScope(current => ({ ...current, people: current.people.filter(item => item.accountId !== person.accountId) }))} aria-label={`Unpin ${person.displayName}`}><X size={13} /></button></span>)}
        <ScopePicker<TeamPerson> label="Pin person" placeholder="Search people by name" search={query => invoke<TeamPerson[]>('search_users', { query })} optionKey={person => person.accountId}
          renderOption={person => <><Avatar name={person.displayName} url={person.avatarUrl} size={20} /><span>{person.displayName}</span></>}
          onSelect={person => setScope(current => current.people.some(item => item.accountId === person.accountId) ? current : { ...current, people: [...current.people, person] })}
          emptyText={query => query.length < 2 ? 'Type at least 2 characters.' : 'No matching people.'} />
      </div>
    </div>

    {!hasScope ? <div className="team-empty"><UserRound size={22} aria-hidden="true" /><strong>Build your team view</strong><span>Add a Jira project to see everyone who logs time on it, or pin people so they always appear, even on days they log nothing.</span></div>
      : error ? <div className="team-empty"><strong>Team worklogs could not load</strong><span>{error}</span><button type="button" onClick={onRefresh}>Try again</button></div>
      : !isLoading && !rows.length ? <div className="team-empty"><strong>No worklogs in {periodLabel}</strong><span>Nobody in this scope logged time for this {calendarMode}. Try another {calendarMode}, or pin people to track their missing days.</span></div>
      : isTickets ? <TicketTable rows={ticketRows} isLoading={isLoading} periodLabel={periodLabel} fieldsMissing={props.fieldsMissing} />
      : <div className="team-grid-wrap" style={{ '--day-count': periodDays.length } as CSSProperties}>
        <table className={`team-grid${calendarMode === 'month' ? ' is-dense' : ''}`}>
          <thead><tr>
            <th scope="col" className="person-col">Person</th>
            {periodDays.map(date => <th scope="col" key={localDate(date)} className={`${isWeekend(date) ? 'weekend-col' : ''}${localDate(date) === todayValue ? ' today-col' : ''}`}><span>{weekdayLabels[(date.getDay() + 6) % 7]}</span><strong>{date.getDate()}</strong></th>)}
            <th scope="col" className="total-col">Total</th>
          </tr></thead>
          <tbody>{rows.map(row => <tr key={row.accountId}>
            <th scope="row" className="person-col"><div className="person-cell"><Avatar name={row.name} url={row.avatarUrl} /><span>{row.name}</span>{row.pinned && <Pin size={12} className="pin-mark" aria-label="Pinned" />}</div></th>
            {periodDays.map(date => {
              const hours = row.hoursByDate.get(localDate(date)) ?? 0;
              const missing = missingFor(row, date);
              const focusState = !showFocus ? '' : missing > 0 ? ' is-incomplete' : ' is-muted';
              return <td key={localDate(date)} className={`hours-cell${hours ? ' has-hours' : ''}${isWeekend(date) ? ' weekend-col' : ''}${focusState}`}>
                <button type="button" onClick={() => setDetail({ row, date })} title={`${row.name} · ${longDate(date)}: ${formatHours(hours)} logged${showFocus && missing > 0 ? `, ${formatHours(missing)} missing` : ''}`} aria-label={`${row.name}, ${longDate(date)}: ${hours ? `${formatHours(hours)} logged` : 'no time logged'}${showFocus && missing > 0 ? `, ${formatHours(missing)} missing` : ''}`}>
                  {hours ? formatHours(hours) : '–'}
                  {showFocus && missing > 0 && calendarMode === 'week' && <small>−{formatHours(missing)}</small>}
                  {!isWeekend(date) && <span className="cell-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, hours / workdayHours * 100)}%` }} /></span>}
                </button>
              </td>;
            })}
            <td className="total-col">{formatHours(row.total)}</td>
          </tr>)}</tbody>
          <tfoot><tr>
            <th scope="row" className="person-col">Day total</th>
            {dayTotals.map((total, index) => <td key={localDate(periodDays[index])} className={isWeekend(periodDays[index]) ? 'weekend-col' : ''}>{total ? formatHours(total) : '–'}</td>)}
            <td className="total-col">{formatHours(grandTotal)}</td>
          </tr></tfoot>
        </table>
        {isLoading && <div className="calendar-loading"><span />Loading team worklogs</div>}
      </div>}
    {!isTickets && hideWeekends && !isLoading && rows.some(row => [...row.hoursByDate.keys()].some(value => isWeekend(new Date(`${value}T12:00:00`)))) && <p className="team-note">Weekend hours are hidden from the grid but included in totals.</p>}

    {detail && <div className="popover-backdrop" onClick={() => setDetail(null)}>
      <section className="team-detail" role="dialog" aria-modal="true" aria-labelledby="team-detail-title" onClick={event => event.stopPropagation()}>
        <button className="close" onClick={() => setDetail(null)} aria-label="Close"><X size={18} /></button>
        <div className="team-detail-head"><Avatar name={detail.row.name} url={detail.row.avatarUrl} size={34} /><div><h2 id="team-detail-title">{detail.row.name}</h2><p>{longDate(detail.date)} · {formatHours(detailHours)} logged{detailMissing > 0 ? ` · ${formatHours(detailMissing)} missing` : ''}</p></div></div>
        {detailLogs.length ? <ul className="team-detail-list">{[...detailLogs].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map(log => <li key={log.id}>
          <div><b>{log.issue}</b><span>{log.summary}</span><em>{formatHours(log.durationMinutes / 60)}</em></div>
          <small>{log.startedAt.slice(11, 16)}{log.description ? ` · ${log.description}` : ''}</small>
        </li>)}</ul> : <p className="team-detail-empty">No time logged on this day.</p>}
      </section>
    </div>}
  </section>;
}
