import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CalendarCheck, CircleGauge, Flame, RefreshCw, Target, TrendingUp } from 'lucide-react';
import { SyncNotice } from './sync';
import { addDays, completeSync, formatHours, hoursNumber, isWeekend, localDate, readableError, type SyncStatus } from './utils';

type JiraWorklog = { id: string; date: string; startedAt: string; issue: string; summary: string; durationMinutes: number; description: string };
type WeekWorklogs = { worklogs: JiraWorklog[]; sync: SyncStatus };
type JiraConnection = { connected: boolean };
type Log = { date: string; issue: string; title: string; hours: number };

const maxWeeks = 12;
const rangeOptions = [4, 8, 12] as const;
const weekdayShort = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const startOfWeek = (date: Date) => { const monday = new Date(date); monday.setHours(12, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7)); return monday; };
const dayLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const weekLabel = (date: Date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

type InsightsProps = { workdayHours: number; onOpenDay: (date: string) => void };

export function Insights({ workdayHours, onOpenDay }: InsightsProps) {
  const [weeks, setWeeks] = useState<(typeof rangeOptions)[number]>(8);
  const [logs, setLogs] = useState<Log[]>([]);
  const [sync, setSync] = useState<SyncStatus>(completeSync);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const today = localDate(new Date());
  const firstMonday = useMemo(() => addDays(startOfWeek(new Date()), -(maxWeeks - 1) * 7), []);

  useEffect(() => {
    let isCurrent = true;
    const start = localDate(firstMonday);
    const end = localDate(addDays(startOfWeek(new Date()), 7));
    setStatus('loading');
    invoke<JiraConnection>('jira_connection').then(connection => {
      if (!connection.connected) throw new Error('Connect your Jira account from Settings to see insights.');
      return invoke<WeekWorklogs>('get_week_worklogs', { startDate: start, endDate: end, startedAfter: new Date(`${start}T00:00:00`).getTime() - 86_400_000, startedBefore: new Date(`${end}T00:00:00`).getTime() + 86_400_000 });
    }).then(result => {
      if (!isCurrent) return;
      setLogs(result.worklogs.map(worklog => ({ date: worklog.date, issue: worklog.issue, title: worklog.summary, hours: worklog.durationMinutes / 60 })));
      setSync(result.sync); setStatus('ready');
    }).catch(failure => { if (!isCurrent) return; setError(failure instanceof Error ? failure.message : readableError(failure)); setStatus('error'); });
    return () => { isCurrent = false; };
  }, [firstMonday, reload]);

  const refresh = useCallback(() => setReload(value => value + 1), []);

  const stats = useMemo(() => {
    const rangeStart = localDate(addDays(startOfWeek(new Date()), -(weeks - 1) * 7));
    const inRange = logs.filter(log => log.date >= rangeStart && log.date <= today);
    const byDate = new Map<string, number>();
    for (const log of inRange) byDate.set(log.date, (byDate.get(log.date) ?? 0) + log.hours);

    const days: { date: string; hours: number; working: boolean; past: boolean }[] = [];
    for (let date = new Date(`${rangeStart}T12:00:00`); localDate(date) <= today; date = addDays(date, 1)) {
      const key = localDate(date);
      days.push({ date: key, hours: byDate.get(key) ?? 0, working: !isWeekend(date), past: key < today });
    }
    const pastWorking = days.filter(day => day.working && day.past);
    const total = inRange.reduce((sum, log) => sum + log.hours, 0);
    const target = pastWorking.length * workdayHours;
    const loggedOnPast = pastWorking.reduce((sum, day) => sum + day.hours, 0);
    const complete = (day: { hours: number }) => day.hours >= workdayHours - 0.01;
    let streak = 0;
    for (let index = pastWorking.length - 1; index >= 0 && complete(pastWorking[index]); index--) streak++;
    const incomplete = pastWorking.filter(day => !complete(day)).reverse();
    const best = days.reduce((top, day) => day.hours > top.hours ? day : top, { date: '', hours: 0 });

    const weekBars = Array.from({ length: weeks }, (_, index) => {
      const monday = addDays(startOfWeek(new Date()), -(weeks - 1 - index) * 7);
      const dates = Array.from({ length: 7 }, (_, offset) => localDate(addDays(monday, offset)));
      const hours = dates.reduce((sum, date) => sum + (byDate.get(date) ?? 0), 0);
      const workingDays = dates.filter((date, offset) => offset < 5 && date < today).length;
      return { label: weekLabel(monday), hours, target: workingDays * workdayHours, isCurrent: dates.includes(today), isEmpty: workingDays === 0 };
    });

    const showWeekend = days.some(day => day.hours > 0 && !day.working);
    const weekdayTotals = weekdayShort.map((label, offset) => {
      const matching = days.filter(day => (new Date(`${day.date}T12:00:00`).getDay() + 6) % 7 === offset && day.past);
      const hours = matching.reduce((sum, day) => sum + day.hours, 0);
      return { label, average: matching.length ? hours / matching.length : 0 };
    }).slice(0, showWeekend ? 7 : 5);

    const issueTotals = new Map<string, { issue: string; title: string; hours: number }>();
    const projectTotals = new Map<string, number>();
    for (const log of inRange) {
      const entry = issueTotals.get(log.issue) ?? { issue: log.issue, title: log.title, hours: 0 };
      entry.hours += log.hours; issueTotals.set(log.issue, entry);
      const project = log.issue.split('-')[0] || 'Other';
      projectTotals.set(project, (projectTotals.get(project) ?? 0) + log.hours);
    }
    const topIssues = [...issueTotals.values()].sort((a, b) => b.hours - a.hours).slice(0, 6);
    const projects = [...projectTotals].map(([project, hours]) => ({ project, hours })).sort((a, b) => b.hours - a.hours);

    return {
      total, target, streak, incomplete, best, weekBars, weekdayTotals, topIssues, projects,
      completion: target ? Math.min(100, Math.round((loggedOnPast / target) * 100)) : 0,
      average: pastWorking.length ? loggedOnPast / pastWorking.length : 0,
      activeIssues: issueTotals.size,
    };
  }, [logs, weeks, workdayHours, today]);

  const chartMax = Math.max(1, ...stats.weekBars.map(week => Math.max(week.hours, week.target)));
  const weekdayMax = Math.max(1, workdayHours, ...stats.weekdayTotals.map(day => day.average));
  const issueMax = Math.max(1, ...stats.topIssues.map(issue => issue.hours));
  const hasData = stats.total > 0;

  return <section className="insights-page" aria-labelledby="insights-title">
    <header className="insights-head">
      <div><h1 id="insights-title">Insights</h1><p>How your time logging looks over the last {weeks} weeks.</p></div>
      <div className="insights-controls">
        <div className="segmented" role="group" aria-label="Range">{rangeOptions.map(option => <button key={option} aria-pressed={weeks === option} onClick={() => setWeeks(option)}>{option} weeks</button>)}</div>
        <button className={`icon-button refresh-button${status === 'loading' ? ' is-spinning' : ''}`} onClick={refresh} disabled={status === 'loading'} aria-label="Refresh insights" title="Refresh from Jira"><RefreshCw size={18} /></button>
      </div>
    </header>
    <SyncNotice sync={sync} onRetry={refresh} />
    {status === 'error' && <p className="connection-error" role="alert">{error}</p>}
    {status === 'loading' && !hasData && <p className="insights-empty">Loading your worklogs…</p>}
    {status === 'ready' && !hasData && <div className="insights-empty"><strong>No worklogs in this period</strong><span>Once you log time in Jira, your totals, trends and gaps show up here.</span></div>}
    {hasData && <>
      <div className="insight-cards">
        <article className="insight-card"><div className="insight-icon"><CircleGauge size={17} /></div><span>Logged</span><strong>{formatHours(hoursNumber(stats.total))}</strong><small>of {formatHours(hoursNumber(stats.target))} target to date</small></article>
        <article className="insight-card"><div className="insight-icon"><Target size={17} /></div><span>Completion</span><strong>{stats.completion}%</strong><small>{stats.incomplete.length} incomplete {stats.incomplete.length === 1 ? 'day' : 'days'}</small></article>
        <article className="insight-card"><div className="insight-icon"><TrendingUp size={17} /></div><span>Daily average</span><strong>{formatHours(hoursNumber(stats.average))}</strong><small>per working day · target {formatHours(workdayHours)}</small></article>
        <article className="insight-card"><div className="insight-icon"><Flame size={17} /></div><span>Current streak</span><strong>{stats.streak} {stats.streak === 1 ? 'day' : 'days'}</strong><small>complete working days in a row</small></article>
        <article className="insight-card"><div className="insight-icon"><CalendarCheck size={17} /></div><span>Busiest day</span><strong>{stats.best.date ? formatHours(hoursNumber(stats.best.hours)) : '—'}</strong><small>{stats.best.date ? dayLabel(stats.best.date) : 'No logs yet'}</small></article>
      </div>

      <div className="insight-grid">
        <article className="insight-panel wide">
          <header><h2>Hours per week</h2><span className="insight-legend"><i className="logged" />Logged<i className="target" />Target so far</span></header>
          <div className="week-chart" role="img" aria-label="Logged hours per week compared with target">
            {stats.weekBars.map(week => <div className="week-column" key={week.label} title={`${week.label}: ${formatHours(hoursNumber(week.hours))} of ${formatHours(week.target)}`}>
              <b>{week.hours ? formatHours(hoursNumber(week.hours)) : ''}</b>
              <div className="week-track">
                {!week.isEmpty && <i className="week-target" style={{ bottom: `${(week.target / chartMax) * 100}%` }} />}
                <i className={`week-bar${week.hours >= week.target && !week.isEmpty ? ' met' : ''}${week.isCurrent ? ' current' : ''}`} style={{ height: `${(week.hours / chartMax) * 100}%` }} />
              </div>
              <span>{week.label}</span>
            </div>)}
          </div>
        </article>

        <article className="insight-panel">
          <header><h2>Average by weekday</h2></header>
          <ul className="bar-list">{stats.weekdayTotals.map(day => <li key={day.label}><span>{day.label}</span><div className="bar-track"><i style={{ width: `${(day.average / weekdayMax) * 100}%` }} /><em style={{ left: `${(workdayHours / weekdayMax) * 100}%` }} /></div><b>{formatHours(hoursNumber(day.average))}</b></li>)}</ul>
        </article>

        <article className="insight-panel">
          <header><h2>Where your time goes</h2><span className="insight-meta">{stats.activeIssues} {stats.activeIssues === 1 ? 'issue' : 'issues'}</span></header>
          <ul className="bar-list issues">{stats.topIssues.map(issue => <li key={issue.issue}><span title={issue.title}><b>{issue.issue}</b> {issue.title}</span><div className="bar-track"><i style={{ width: `${(issue.hours / issueMax) * 100}%` }} /></div><b>{formatHours(hoursNumber(issue.hours))}</b></li>)}</ul>
          {stats.projects.length > 1 && <p className="project-split">{stats.projects.slice(0, 4).map(project => <span key={project.project}><b>{project.project}</b> {Math.round((project.hours / stats.total) * 100)}%</span>)}</p>}
        </article>

        <article className="insight-panel">
          <header><h2>Days to fill in</h2><span className="insight-meta">{stats.incomplete.length}</span></header>
          {stats.incomplete.length === 0 ? <p className="insight-ok">Every past working day in this period reaches {formatHours(workdayHours)}. Nice.</p> : <ul className="gap-list">{stats.incomplete.slice(0, 6).map(day => <li key={day.date}><div><strong>{dayLabel(day.date)}</strong><small>{formatHours(hoursNumber(day.hours))} logged · {formatHours(hoursNumber(workdayHours - day.hours))} missing</small></div><button onClick={() => onOpenDay(day.date)}>Open day</button></li>)}</ul>}
          {stats.incomplete.length > 6 && <p className="insight-more">+{stats.incomplete.length - 6} older days</p>}
        </article>
      </div>
    </>}
  </section>;
}
