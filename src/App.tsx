import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { TeamWorklogs, buildTeamRows, teamExportFiles, useTeamScope, useTeamWorklogs } from './team';
import { useTicketFields } from './tickets';
import { MonthPicker } from './month-picker';
import { addDays, daysBetween, formatHours, localDate, readableError, toCsv, weekdayLabels } from './utils';
import {
  Bell, BellRing, Bookmark, Bug, CalendarDays, Check, ChevronLeft, ChevronRight, Circle, CircleHelp, Clock3,
  Download, ExternalLink, FileSpreadsheet, LayoutDashboard, ListTree, Moon, Plus,
  KeyRound, Palette, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, SquareCheck, Sun, TimerReset, UsersRound, X, Zap,
  type LucideIcon,
} from 'lucide-react';

type Worklog = {
  id: number; date: string; issue: string; title: string; duration: number;
  start: number; accent: 'teal' | 'blue' | 'violet' | 'coral'; description: string;
};
type DayIssue = { issue: string; title: string; duration: number; accent: Worklog['accent'] };
type CachedRange = { start: string; end: string; logs: Worklog[] };

type JiraWorklog = { id: string; date: string; startedAt: string; issue: string; summary: string; durationMinutes: number; description: string };
type JiraConnection = { connected: boolean; displayName?: string; siteName?: string };

const displayDate = (date: Date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const startOfWeek = (date = new Date()) => { const monday = new Date(date); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7)); return monday; };
const accents: Worklog['accent'][] = ['teal', 'blue', 'violet', 'coral'];
const accentFor = (issue: string) => accents[[...issue].reduce((sum, character) => sum + character.charCodeAt(0), 0) % accents.length];

type PlacedWorklog = { log: Worklog; column: number; columns: number };
const placeDayWorklogs = (dayLogs: Worklog[], minimumDuration: number): PlacedWorklog[] => {
  const placed: PlacedWorklog[] = [];
  let cluster: PlacedWorklog[] = []; let columnEnds: number[] = []; let clusterEnd = -1;
  const closeCluster = () => { cluster.forEach(item => { item.columns = columnEnds.length; }); placed.push(...cluster); cluster = []; columnEnds = []; clusterEnd = -1; };
  for (const log of [...dayLogs].sort((a, b) => a.start - b.start || b.duration - a.duration)) {
    if (cluster.length && log.start >= clusterEnd) closeCluster();
    const visualEnd = log.start + Math.max(log.duration, minimumDuration);
    let column = columnEnds.findIndex(end => end <= log.start);
    if (column === -1) { column = columnEnds.length; columnEnds.push(0); }
    columnEnds[column] = visualEnd;
    cluster.push({ log, column, columns: 1 });
    clusterEnd = Math.max(clusterEnd, visualEnd);
  }
  if (cluster.length) closeCluster();
  return placed;
};
type JiraIssue = { key: string; summary: string; status?: string; updated?: string; issueType?: string; issueTypeIcon?: string };
const fallbackTypeIcons: Record<string, { icon: LucideIcon; tone: string }> = {
  bug: { icon: Bug, tone: 'bug' }, story: { icon: Bookmark, tone: 'story' }, task: { icon: SquareCheck, tone: 'task' },
  'sub-task': { icon: ListTree, tone: 'task' }, subtask: { icon: ListTree, tone: 'task' }, epic: { icon: Zap, tone: 'epic' }, enhancement: { icon: Sparkles, tone: 'story' },
};
function IssueTypeIcon({ issue }: { issue: JiraIssue }) {
  const [hasFailed, setHasFailed] = useState(false);
  const name = issue.issueType ?? 'Issue';
  if (issue.issueTypeIcon && !hasFailed) return <img className="issue-type-icon" src={issue.issueTypeIcon} alt={name} title={name} width={16} height={16} onError={() => setHasFailed(true)} />;
  const { icon: Icon, tone } = fallbackTypeIcons[name.toLowerCase()] ?? { icon: Circle, tone: 'other' };
  return <span className={`issue-type-icon fallback ${tone}`} role="img" aria-label={name} title={name}><Icon size={14} strokeWidth={2.4} /></span>;
}
type IssueFilter = 'recent' | 'viewed';
const issueFilters: { value: IssueFilter; label: string }[] = [{ value: 'recent', label: 'Recent activity' }, { value: 'viewed', label: 'Recently viewed' }];
const relativeTime = (value?: string) => {
  if (!value) return '';
  const time = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime();
  if (Number.isNaN(time)) return '';
  const minutes = Math.max(1, Math.round((Date.now() - time) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  if (minutes < 43_200) return `${Math.round(minutes / 1440)}d ago`;
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const siteHost = (site?: string) => { try { return site ? new URL(site).host : 'Jira'; } catch { return site ?? 'Jira'; } };

export default function App() {
  const [logs, setLogs] = useState<Worklog[]>([]);
  const [isDark, setIsDark] = useState(() => localStorage.getItem('trackline.theme') !== 'light');
  useEffect(() => { localStorage.setItem('trackline.theme', isDark ? 'dark' : 'light'); }, [isDark]);
  const [view, setView] = useState<'calendar' | 'settings' | 'worklogs'>('calendar');
  const [reminderEnabled, setReminderEnabled] = useState(() => localStorage.getItem('trackline.reminderEnabled') !== 'false');
  const [reminderTime, setReminderTime] = useState(() => localStorage.getItem('trackline.reminderTime') ?? '16:00');
  useEffect(() => { localStorage.setItem('trackline.reminderEnabled', String(reminderEnabled)); }, [reminderEnabled]);
  useEffect(() => { localStorage.setItem('trackline.reminderTime', reminderTime); }, [reminderTime]);
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [workdayHours, setWorkdayHours] = useState(() => Number(localStorage.getItem('trackline.workdayHours')) || 8);
  const [workdayInput, setWorkdayInput] = useState(() => String(Number(localStorage.getItem('trackline.workdayHours')) || 8));
  useEffect(() => { localStorage.setItem('trackline.workdayHours', String(workdayHours)); }, [workdayHours]);
  const [focusIncomplete, setFocusIncomplete] = useState(() => localStorage.getItem('trackline.focusIncomplete') === 'true');
  const [hideWeekends, setHideWeekends] = useState(() => localStorage.getItem('trackline.hideWeekends') !== 'false');
  useEffect(() => { localStorage.setItem('trackline.focusIncomplete', String(focusIncomplete)); }, [focusIncomplete]);
  useEffect(() => { localStorage.setItem('trackline.hideWeekends', String(hideWeekends)); }, [hideWeekends]);
  const updateWorkdayHours = (value: string) => {
    setWorkdayInput(value);
    const hoursPerDay = Number(value);
    if (Number.isFinite(hoursPerDay) && hoursPerDay >= 0.5 && hoursPerDay <= 24) setWorkdayHours(hoursPerDay);
  };
  const isWorkdayInputValid = Number(workdayInput) >= 0.5 && Number(workdayInput) <= 24;
  const [modal, setModal] = useState<'log' | 'export' | null>(null);
  const [issueFilter, setIssueFilter] = useState<IssueFilter>('recent');
  const [issueQuery, setIssueQuery] = useState('');
  const [issueLists, setIssueLists] = useState<Partial<Record<IssueFilter, JiraIssue[]>>>({});
  const [issueListError, setIssueListError] = useState('');
  const [isIssueListLoading, setIsIssueListLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<JiraIssue[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<JiraIssue | null>(null);
  const [activeOption, setActiveOption] = useState(0);
  const [issueError, setIssueError] = useState('');
  const [isSavingLog, setIsSavingLog] = useState(false);
  const [saveLogError, setSaveLogError] = useState('');
  const [selected, setSelected] = useState<Worklog | null>(null);
  const [toast, setToast] = useState('');
  const [entry, setEntry] = useState({ issue: '', duration: '1', date: localDate(new Date()), time: '09:00', description: '' });
  const [exportScope, setExportScope] = useState('My calendar');
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [syncState, setSyncState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [syncError, setSyncError] = useState('');
  const [isCalendarLoading, setIsCalendarLoading] = useState(true);
  const rangeCache = useRef<CachedRange[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [jiraAccount, setJiraAccount] = useState<JiraConnection | null>(null);
  const [siteUrl, setSiteUrl] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [calendarMode, setCalendarMode] = useState<'week' | 'month'>('week');
  const [focusDate, setFocusDate] = useState(() => new Date());
  const todayValue = localDate(new Date());
  const weekStart = useMemo(() => startOfWeek(focusDate), [focusDate]);
  const monthStart = useMemo(() => new Date(focusDate.getFullYear(), focusDate.getMonth(), 1), [focusDate]);
  const days = useMemo(() => Array.from({ length: hideWeekends ? 5 : 7 }, (_, index) => {
    const date = addDays(weekStart, index);
    const weekend = index >= 5;
    return { label: weekdayLabels[index], date: String(date.getDate()).padStart(2, '0'), total: weekend ? 0 : workdayHours, value: localDate(date), weekend };
  }), [weekStart, workdayHours, hideWeekends]);
  const monthDays = useMemo(() => {
    const gridStart = startOfWeek(monthStart);
    const gridEnd = addDays(startOfWeek(new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0)), 7);
    return Array.from({ length: Math.round((gridEnd.getTime() - gridStart.getTime()) / 86_400_000) }, (_, index) => addDays(gridStart, index));
  }, [monthStart]);
  const range = calendarMode === 'week'
    ? { start: localDate(weekStart), end: localDate(addDays(weekStart, 7)) }
    : { start: localDate(monthDays[0]), end: localDate(addDays(monthDays[monthDays.length - 1], 1)) };

  useEffect(() => {
    let isCurrentRange = true;
    const { start, end } = range;
    const cached = rangeCache.current.find(entry => entry.start <= start && entry.end >= end);
    if (cached) { setLogs(cached.logs.filter(log => log.date >= start && log.date < end)); setIsCalendarLoading(false); return; }
    setIsCalendarLoading(true); setLogs([]);
    invoke<JiraConnection>('jira_connection').then(connection => {
      if (isCurrentRange) setJiraAccount(connection);
      if (!connection.connected) throw new Error('Connect your Jira account from Settings to load worklogs.');
      return invoke<JiraWorklog[]>('get_week_worklogs', { startDate: start, endDate: end, startedAfter: new Date(`${start}T00:00:00`).getTime() - 86_400_000, startedBefore: new Date(`${end}T00:00:00`).getTime() + 86_400_000 });
    })
      .then(worklogs => {
        const rangeLogs = worklogs.map(worklog => {
          const [hour, minute] = worklog.startedAt.slice(11, 16).split(':').map(Number);
          return { id: Number(worklog.id), date: worklog.date, issue: worklog.issue, title: worklog.summary, duration: worklog.durationMinutes / 60, start: hour + minute / 60, accent: accentFor(worklog.issue), description: worklog.description || 'Jira worklog' };
        });
        rangeCache.current.push({ start, end, logs: rangeLogs });
        if (!isCurrentRange) return;
        setLogs(rangeLogs); setSyncState('ready'); setIsCalendarLoading(false);
      })
      .catch(error => { if (!isCurrentRange) return; setSyncError(readableError(error)); setSyncState('error'); setIsCalendarLoading(false); });
    return () => { isCurrentRange = false; };
  }, [range.start, range.end]);
  const connectToJira = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsConnecting(true); setSyncState('loading'); setSyncError('');
    try {
      const connection = await invoke<JiraConnection>('connect_jira', { siteUrl, email, apiToken });
      setApiToken(''); setJiraAccount(connection); setSyncState('ready'); showToast(`Connected to ${connection.siteName ?? 'Jira'}. Reload Trackline to fetch your calendar.`);
    } catch (error) { setSyncState('error'); setSyncError(readableError(error)); }
    finally { setIsConnecting(false); }
  };
  const hoursByDate = useMemo(() => logs.reduce((totals, log) => totals.set(log.date, (totals.get(log.date) ?? 0) + log.duration), new Map<string, number>()), [logs]);
  const issuesByDate = useMemo(() => {
    const grouped = new Map<string, Map<string, DayIssue>>();
    for (const log of logs) {
      const dayIssues = grouped.get(log.date) ?? new Map<string, DayIssue>();
      dayIssues.set(log.issue, { issue: log.issue, title: log.title, accent: log.accent, duration: (dayIssues.get(log.issue)?.duration ?? 0) + log.duration });
      grouped.set(log.date, dayIssues);
    }
    return new Map([...grouped].map(([date, dayIssues]) => [date, [...dayIssues.values()].sort((a, b) => b.duration - a.duration)]));
  }, [logs]);
  const monthKey = localDate(monthStart).slice(0, 7);
  const isInPeriod = (date: string) => calendarMode === 'week' ? date >= localDate(weekStart) && date < localDate(addDays(weekStart, 7)) : date.startsWith(monthKey);
  const periodLogs = logs.filter(log => isInPeriod(log.date));
  const weekLogs = logs.filter(log => days.some(day => day.value === log.date));
  const firstHour = Math.max(0, Math.min(8, ...weekLogs.map(log => Math.floor(log.start))));
  const lastHour = Math.min(24, Math.max(18, ...weekLogs.map(log => Math.ceil(log.start + log.duration))));
  const hourHeight = Math.max(44, Math.min(69, Math.floor(690 / (lastHour - firstHour))));
  const hours = Array.from({ length: lastHour - firstHour }, (_, index) => firstHour + index);
  const now = new Date();
  const nowHours = now.getHours() + now.getMinutes() / 60;
  const nowLabel = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const [hoverSlot, setHoverSlot] = useState<{ date: string; start: number } | null>(null);
  const slotTime = (hoursValue: number) => `${String(Math.floor(hoursValue)).padStart(2, '0')}:${String(Math.round((hoursValue % 1) * 60)).padStart(2, '0')}`;
  const slotFromPointer = (event: React.MouseEvent<HTMLDivElement>) => {
    const offset = event.clientY - event.currentTarget.getBoundingClientRect().top;
    return Math.min(Math.max(Math.floor((firstHour + offset / hourHeight) * 4) / 4, 0), 23.75);
  };
  const isOnWorklog = (event: React.MouseEvent) => (event.target as HTMLElement).closest('.worklog') !== null;
  const periodTotal = periodLogs.reduce((sum, log) => sum + log.duration, 0);
  const periodTarget = (calendarMode === 'week' ? 5 : monthDays.filter(date => date.getMonth() === monthStart.getMonth() && date.getDay() % 6 !== 0).length) * workdayHours;
  const loggedDays = new Set(periodLogs.map(log => log.date)).size;
  const missingHoursFor = (date: Date) => {
    const value = localDate(date);
    if (date.getDay() % 6 === 0 || value > todayValue) return 0;
    const missing = workdayHours - (hoursByDate.get(value) ?? 0);
    return missing > 0.01 ? missing : 0;
  };
  const showFocus = focusIncomplete && !isCalendarLoading && syncState === 'ready';
  const focusClass = (missing: number) => !showFocus ? '' : missing > 0 ? ' is-incomplete' : ' is-muted';
  const incompleteCount = (calendarMode === 'week' ? days.map(day => new Date(`${day.value}T12:00:00`)) : monthDays.filter(date => date.getMonth() === monthStart.getMonth())).filter(date => missingHoursFor(date) > 0).length;
  const visibleWeekdays = hideWeekends ? weekdayLabels.slice(0, 5) : weekdayLabels;
  const visibleMonthDays = hideWeekends ? monthDays.filter(date => date.getDay() % 6 !== 0) : monthDays;
  const [teamScope, setTeamScope] = useTeamScope();
  const teamRange = calendarMode === 'week'
    ? { start: localDate(weekStart), end: localDate(addDays(weekStart, 7)) }
    : { start: localDate(monthStart), end: localDate(new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1)) };
  const ticketFields = useTicketFields(syncState === 'ready');
  const team = useTeamWorklogs(teamScope, teamRange, (view === 'worklogs' || modal === 'export') && ticketFields.isReady, ticketFields.config);
  const teamRows = useMemo(() => buildTeamRows(team.worklogs, teamScope.people), [team.worklogs, teamScope.people]);
  const teamDates = daysBetween(teamRange.start, teamRange.end);
  const teamPeriodDays = hideWeekends ? teamDates.filter(date => date.getDay() % 6 !== 0) : teamDates;
  const hasTeamScope = teamScope.projects.length > 0 || teamScope.people.length > 0;
  const teamScopeText = [...teamScope.projects.map(project => project.key), ...teamScope.people.map(person => person.displayName)].join(', ');
  const openExport = () => { setExportScope(view === 'worklogs' && hasTeamScope ? 'Team worklogs' : 'My calendar'); setExportError(''); setModal('export'); };
  const recentIssues = [...periodLogs.reduce((issues, log) => {
    const current = issues.get(log.issue);
    return issues.set(log.issue, { issue: log.issue, title: log.title, accent: log.accent, hours: (current?.hours ?? 0) + log.duration, lastDate: current && current.lastDate > log.date ? current.lastDate : log.date });
  }, new Map<string, { issue: string; title: string; accent: Worklog['accent']; hours: number; lastDate: string }>()).values()].sort((a, b) => b.lastDate.localeCompare(a.lastDate) || b.hours - a.hours);
  const attentionDays = (calendarMode === 'week' ? days.filter(day => !day.weekend).map(day => new Date(`${day.value}T12:00:00`)) : monthDays.filter(date => date.getMonth() === monthStart.getMonth()))
    .map(date => ({ date, missing: missingHoursFor(date) })).filter(day => day.missing > 0);
  const openIssue = (key: string) => { invoke('open_issue', { issueKey: key }).catch(error => showToast(readableError(error))); };

  useEffect(() => {
    if (!reminderEnabled) return;
    const checkReminder = async () => {
      const now = new Date();
      const today = localDate(now);
      const [hour, minute] = reminderTime.split(':').map(Number);
      if (now.getDay() % 6 === 0 || now.getHours() * 60 + now.getMinutes() < hour * 60 + minute) return;
      if (localStorage.getItem('trackline.reminderSentOn') === today) return;
      localStorage.setItem('trackline.reminderSentOn', today);
      let logged = 0;
      try {
        const entries = await invoke<JiraWorklog[]>('get_week_worklogs', { startDate: today, endDate: localDate(addDays(now, 1)), startedAfter: new Date(`${today}T00:00:00`).getTime() - 86_400_000, startedBefore: new Date(`${today}T00:00:00`).getTime() + 2 * 86_400_000 });
        logged = entries.reduce((sum, item) => sum + item.durationMinutes / 60, 0);
      } catch { return; }
      if (workdayHours - logged <= 0.01) return;
      const body = logged ? `You’ve logged ${formatHours(logged)} of ${formatHours(workdayHours)} today.` : `Nothing logged yet today. Your target is ${formatHours(workdayHours)}.`;
      showToast(`Time to log your hours. ${body}`);
      try {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === 'granted';
        if (granted) sendNotification({ title: 'Log your time in Trackline', body });
      } catch { /* The in-app message above is the fallback. */ }
    };
    checkReminder();
    const timer = window.setInterval(checkReminder, 60_000);
    return () => window.clearInterval(timer);
  }, [reminderEnabled, reminderTime, workdayHours]);
  const periodLabel = calendarMode === 'week' ? `${displayDate(weekStart)} — ${displayDate(addDays(weekStart, days.length - 1))}` : monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const pulseValue = todayValue >= range.start && todayValue < range.end ? todayValue : days[4].value;
  const pulseTotal = hoursByDate.get(pulseValue) ?? 0;
  const pulseLabel = new Date(`${pulseValue}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase();
  const pulseEntries = logs.filter(log => log.date === pulseValue).length;
  const pulseMissing = Math.max(0, workdayHours - pulseTotal);
  const isPulseToday = pulseValue === todayValue;
  const entriesText = (count: number) => `${count} ${count === 1 ? 'entry' : 'entries'}`;
  const pulseCopy = isCalendarLoading ? 'Loading your Jira worklogs…'
    : syncState === 'error' ? 'Connect Jira in Settings to see your progress.'
    : pulseMissing <= 0.01 ? `Target reached with ${entriesText(pulseEntries)}${isPulseToday ? ' today' : ''}.`
    : pulseValue > todayValue ? 'This day hasn’t started yet.'
    : pulseTotal > 0 ? `${formatHours(pulseMissing)} to go · ${entriesText(pulseEntries)} logged${isPulseToday ? ' today' : ''}.`
    : isPulseToday ? 'Nothing logged yet today.' : `Nothing was logged on ${new Date(`${pulseValue}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' })}.`;
  const canLogPulse = syncState === 'ready' && !isCalendarLoading && pulseMissing > 0.01 && pulseValue <= todayValue;
  const movePeriod = (direction: -1 | 1) => setFocusDate(current => calendarMode === 'week' ? addDays(current, direction * 7) : new Date(current.getFullYear(), current.getMonth() + direction, 1));
  const openWeek = (date: Date) => { setFocusDate(date); setCalendarMode('week'); };
  const nextStartTime = (date: string) => {
    const lastEnd = logs.filter(log => log.date === date).reduce((last, log) => Math.max(last, log.start + log.duration), 9);
    const minutes = Math.min(Math.ceil(lastEnd * 4) / 4, 23.75) * 60;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  };
  const openLogDialog = (preset?: { date: string; time: string }) => {
    const date = preset?.date ?? (days.some(day => day.value === todayValue) ? todayValue : days[0].value);
    setEntry(current => ({ ...current, issue: '', description: '', date, time: preset?.time ?? nextStartTime(date) }));
    setSelectedIssue(null); setIssueQuery(''); setIssueError(''); setSaveLogError(''); setActiveOption(0); setModal('log');
  };

  useEffect(() => {
    if (modal !== 'log') return;
    let isCurrent = true;
    setIsIssueListLoading(true); setIssueListError('');
    invoke<JiraIssue[]>('list_issues', { filter: issueFilter })
      .then(issues => { if (isCurrent) setIssueLists(current => ({ ...current, [issueFilter]: issues })); })
      .catch(error => { if (isCurrent) setIssueListError(readableError(error)); })
      .finally(() => { if (isCurrent) setIsIssueListLoading(false); });
    return () => { isCurrent = false; };
  }, [modal, issueFilter]);

  useEffect(() => {
    const query = issueQuery.trim();
    if (modal !== 'log' || query.length < 2) { setSearchResults([]); setIsSearching(false); return; }
    let isCurrent = true;
    setIsSearching(true);
    const timer = window.setTimeout(() => {
      invoke<JiraIssue[]>('search_issues', { query })
        .then(issues => { if (isCurrent) setSearchResults(issues); })
        .catch(() => { if (isCurrent) setSearchResults([]); })
        .finally(() => { if (isCurrent) setIsSearching(false); });
    }, 300);
    return () => { isCurrent = false; window.clearTimeout(timer); };
  }, [modal, issueQuery]);

  useEffect(() => { setActiveOption(0); }, [issueQuery, issueFilter]);

  const issueOptions = useMemo(() => {
    const query = issueQuery.trim().toLowerCase();
    const list = issueLists[issueFilter] ?? [];
    const local = query ? list.filter(issue => issue.key.toLowerCase().includes(query) || issue.summary.toLowerCase().includes(query)) : list;
    const localKeys = new Set(local.map(issue => issue.key));
    return { local, remote: searchResults.filter(issue => !localKeys.has(issue.key)) };
  }, [issueQuery, issueLists, issueFilter, searchResults]);
  const flatIssueOptions = [...issueOptions.local, ...issueOptions.remote];
  const hasIssueList = issueLists[issueFilter] !== undefined;

  const chooseIssue = (issue: JiraIssue) => { setSelectedIssue(issue); setEntry(current => ({ ...current, issue: issue.key })); setIssueError(''); };
  const clearIssue = () => { setSelectedIssue(null); setEntry(current => ({ ...current, issue: '' })); setIssueQuery(''); };
  const handleIssueKeys = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveOption(index => Math.min(index + 1, flatIssueOptions.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveOption(index => Math.max(index - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); const issue = flatIssueOptions[activeOption]; if (issue) chooseIssue(issue); }
  };
  const renderIssueOption = (issue: JiraIssue, index: number) => <div role="option" id={`issue-option-${issue.key}`} aria-selected={index === activeOption} className={`issue-option${index === activeOption ? ' active' : ''}`} key={issue.key} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActiveOption(index)} onClick={() => chooseIssue(issue)}><IssueTypeIcon issue={issue} /><b>{issue.key}</b><span>{issue.summary}</span><small>{[issue.status, relativeTime(issue.updated)].filter(Boolean).join(' · ')}</small></div>;

  const showToast = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 3200); };
  const addLog = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedIssue) { setIssueError('Choose the Jira issue this time belongs to.'); return; }
    const durationMinutes = Math.round(Number(entry.duration) * 60);
    if (!durationMinutes || durationMinutes <= 0) { setSaveLogError('Enter how long you worked, for example 1.5 hours.'); return; }
    const local = new Date(`${entry.date}T${entry.time}:00`);
    const offsetMinutes = -local.getTimezoneOffset();
    const offset = `${offsetMinutes >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')}${String(Math.abs(offsetMinutes) % 60).padStart(2, '0')}`;
    const { key, summary } = selectedIssue;
    setIsSavingLog(true); setSaveLogError('');
    try {
      const id = await invoke<string>('add_worklog', { issueKey: key, started: `${entry.date}T${entry.time}:00.000${offset}`, durationMinutes, description: entry.description.trim() });
      const [hour, minute] = entry.time.split(':').map(Number);
      const newLog: Worklog = { id: Number(id), date: entry.date, issue: key, title: summary, duration: durationMinutes / 60, start: hour + minute / 60, accent: accentFor(key), description: entry.description.trim() || 'Jira worklog' };
      rangeCache.current = rangeCache.current.map(cachedRange => cachedRange.start <= entry.date && entry.date < cachedRange.end ? { ...cachedRange, logs: [...cachedRange.logs, newLog] } : cachedRange);
      if (entry.date >= range.start && entry.date < range.end) setLogs(current => [...current, newLog]);
      setModal(null); showToast(`Logged ${formatHours(newLog.duration)} to ${key} in Jira`);
    } catch (error) { setSaveLogError(readableError(error)); }
    finally { setIsSavingLog(false); }
  };
  const exportCalendar = async () => {
    const stamp = `${teamRange.start}_${localDate(addDays(new Date(`${teamRange.end}T12:00:00`), -1))}`;
    const files = exportScope === 'Team worklogs'
      ? teamExportFiles(teamRows, team.worklogs, teamDates, stamp, team.issues)
      : [{ name: `trackline-my-worklogs-${stamp}`, rows: [['Date', 'Start', 'Issue', 'Summary', 'Hours', 'Description'], ...periodLogs.filter(log => log.date >= teamRange.start && log.date < teamRange.end).sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start).map(log => [log.date, `${String(Math.floor(log.start)).padStart(2, '0')}:${String(Math.round((log.start % 1) * 60)).padStart(2, '0')}`, log.issue, log.title, Number(log.duration.toFixed(2)), log.description])] }];
    setIsExporting(true); setExportError('');
    try {
      const paths: string[] = [];
      for (const file of files) paths.push(await invoke<string>('save_csv', { fileName: file.name, content: toCsv(file.rows) }));
      invoke('reveal_file', { path: paths[0] }).catch(() => undefined);
      setModal(null); showToast(paths.length > 1 ? `Saved ${paths.length} CSV files to Downloads` : 'Saved CSV to Downloads');
    } catch (error) { setExportError(readableError(error)); }
    finally { setIsExporting(false); }
  };

  return <main className={isDark ? 'app dark' : 'app'}>
    <aside className="rail" aria-label="Primary navigation">
      <button className="brand" aria-label="Trackline home" onClick={() => setView('calendar')}><span className="brand-mark"><i /><i /><i /></span><span>TRACKLINE</span></button>
      <nav>
        <button className={`nav-item ${view === 'calendar' ? 'active' : ''}`} onClick={() => setView('calendar')}><CalendarDays size={19} /><span>Calendar</span></button>
        <button className={`nav-item ${view === 'worklogs' ? 'active' : ''}`} onClick={() => setView('worklogs')}><TimerReset size={19} /><span>Worklogs</span></button>
        <button className="nav-item" onClick={openExport}><FileSpreadsheet size={19} /><span>Exports</span></button>
        <button className="nav-item" onClick={() => showToast('Insights will be available once more Jira history is synced.')}><LayoutDashboard size={19} /><span>Insights</span></button>
      </nav>
      <div className="rail-spacer" />
      <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}><Settings2 size={19} /><span>Settings</span></button>
       <div className="profile"><div className="avatar">{(jiraAccount?.displayName ?? 'Trackline').split(/[\s.]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('')}</div><div><strong>{jiraAccount?.displayName ?? 'Not connected'}</strong><small>{syncState === 'ready' ? <>Jira connected <Check size={12} /></> : syncState === 'error' ? 'Jira unavailable' : 'Connecting to Jira…'}</small></div></div>
    </aside>

    <section className="workspace">
      {view === 'settings' ? <header className="topbar settings-topbar">
        <button className="back-link" onClick={() => setView('calendar')}><ChevronLeft size={18} />Calendar</button>
        <span className="settings-note"><Check size={14} />Changes apply immediately</span>
      </header> : <header className="topbar">
          <div className="week-switcher"><button onClick={() => movePeriod(-1)} aria-label={`Previous ${calendarMode}`}><ChevronLeft size={19} /></button><div>{calendarMode === 'month' ? <MonthPicker value={monthStart} label={periodLabel} onChange={setFocusDate} /> : <strong>{periodLabel}</strong>}<span aria-live="polite">{(view === 'worklogs' ? team.isLoading : isCalendarLoading) ? 'Syncing Jira worklogs…' : view === 'worklogs' ? 'Team worklogs' : 'Jira worklog calendar'}</span></div><button onClick={() => movePeriod(1)} aria-label={`Next ${calendarMode}`}><ChevronRight size={19} /></button><button className="today-button" onClick={() => setFocusDate(new Date())}>Today</button></div>
        <div className="top-actions"><button className="icon-button" aria-label="Search"><Search size={19} /></button><button className="icon-button theme-toggle" onClick={() => setIsDark(value => !value)} aria-label="Toggle color theme">{isDark ? <Sun size={18} /> : <Moon size={18} />}</button><button className="export-button" onClick={openExport}><Download size={17} />Export</button><button className="primary-button" onClick={() => openLogDialog()}><Plus size={18} />Log time</button></div>
      </header>}

       {view === 'settings' ? <section className="settings-page" aria-labelledby="settings-title">
         <header><h1 id="settings-title">Settings</h1><p>Control how Trackline connects, reminds you, and displays your workweek.</p></header>
         <div className="settings-list">
           <section className="settings-section" aria-labelledby="settings-jira">
             <div className="settings-intro"><KeyRound size={18} aria-hidden="true" /><div><h2 id="settings-jira">Jira connection</h2><p>Connect directly with a personal Atlassian API token. Credentials stay local to this device.</p></div></div>
             <div className="setting-control">
               <div className="connection-status" aria-live="polite">
                 <span className={`status-dot ${syncState}`} aria-hidden="true" />
                 <div>
                   <strong>{syncState === 'ready' ? `Connected to ${siteHost(jiraAccount?.siteName)}` : syncState === 'loading' ? (isConnecting ? 'Connecting to Jira…' : 'Checking connection…') : 'Not connected'}</strong>
                   <small>{syncState === 'ready' ? (jiraAccount?.displayName ? `Signed in as ${jiraAccount.displayName}` : 'Your calendar is ready to sync.') : syncState === 'loading' ? 'Verifying your workspace details.' : 'Add your workspace details to start syncing worklogs.'}</small>
                 </div>
                 {syncState === 'ready' && <button className="quiet-action" onClick={() => { setView('calendar'); window.location.reload(); }}><RefreshCw size={14} />Refresh calendar</button>}
               </div>
               {(syncState === 'error' || isConnecting) && <form className="token-connect" onSubmit={connectToJira}>
                 <div className="field"><label className="field-label" htmlFor="jira-site">Jira site</label><input id="jira-site" type="url" value={siteUrl} onChange={event => setSiteUrl(event.target.value)} placeholder="https://your-site.atlassian.net" autoComplete="url" spellCheck={false} /></div>
                 <div className="field"><label className="field-label" htmlFor="jira-email">Atlassian email</label><input id="jira-email" type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@company.com" autoComplete="email" spellCheck={false} /></div>
                 <div className="field">
                   <div className="field-label"><label htmlFor="jira-token">API token</label><button className="field-link" type="button" onClick={() => invoke('open_api_token_page').catch(() => showToast('Open id.atlassian.com to create an API token.'))}>Create a token<ExternalLink size={12} aria-hidden="true" /></button></div>
                   <input id="jira-token" type="password" value={apiToken} onChange={event => setApiToken(event.target.value)} placeholder="Paste your API token" autoComplete="off" spellCheck={false} />
                 </div>
                 {syncState === 'error' && <p className="connection-error" role="alert">{syncError || 'We could not reach Jira. Check the site address and credentials, then try again.'}</p>}
                 <div className="connect-footer"><span><ShieldCheck size={14} aria-hidden="true" />Stored securely on this device</span><button className="primary-button" type="submit" disabled={isConnecting}>{isConnecting ? 'Connecting…' : 'Connect Jira'}</button></div>
               </form>}
             </div>
           </section>
           <section className="settings-section" aria-labelledby="settings-workday">
             <div className="settings-intro"><Clock3 size={18} aria-hidden="true" /><div><h2 id="settings-workday">Workday length</h2><p>Sets your daily target. Week and month totals use this across working days.</p></div></div>
             <div className="setting-control">
               <div className="field">
                 <label className="field-label" htmlFor="workday-hours">Hours per day</label>
                 <div className="workday-row">
                   <span className="workday-input"><input id="workday-hours" type="number" min="0.5" max="24" step="0.5" value={workdayInput} onChange={event => updateWorkdayHours(event.target.value)} onBlur={() => setWorkdayInput(String(workdayHours))} aria-invalid={!isWorkdayInputValid} aria-describedby="workday-hint" /><em aria-hidden="true">h</em></span>
                   <small id="workday-hint" className={isWorkdayInputValid ? '' : 'invalid'}>{isWorkdayInputValid ? `${formatHours(workdayHours * 5)} per week` : 'Enter 0.5 to 24 hours'}</small>
                 </div>
               </div>
             </div>
           </section>
           <section className="settings-section" aria-labelledby="settings-fields">
             <div className="settings-intro"><ListTree size={18} aria-hidden="true" /><div><h2 id="settings-fields">Jira fields</h2><p>Custom fields shown in the Tickets view and export. Trackline picks them by name; change them if your site uses different fields.</p></div></div>
             <div className="setting-control">
               {syncState !== 'ready' ? <p className="setting-hint">Connect Jira to choose fields.</p> : ticketFields.error ? <p className="setting-hint">{ticketFields.error}</p> : <div className="field-pickers">
                 {([['workTypeField', 'Work type', 'jira-field-work-type'], ['costField', 'Cost/Capitalized', 'jira-field-cost']] as const).map(([key, label, id]) => <div className="field" key={key}>
                   <label className="field-label" htmlFor={id}>{label}</label>
                   <select id={id} className="field-select" value={ticketFields.config[key] ?? ''} onChange={event => ticketFields.setConfig(current => ({ ...current, detected: true, [key]: event.target.value || undefined }))}>
                     <option value="">Not used</option>
                     {ticketFields.options.map(field => <option key={field.id} value={field.id}>{field.name}</option>)}
                   </select>
                 </div>)}
               </div>}
             </div>
           </section>
           <section className="settings-section" aria-labelledby="settings-reminder">
             <div className="settings-intro"><BellRing size={18} aria-hidden="true" /><div><h2 id="settings-reminder">Daily reminder</h2><p>Receive an in-app prompt to finish logging time before your workday ends.</p></div></div>
             <div className="setting-control">
               <div className="reminder-control">
                 <button id="reminder-switch" className={`toggle ${reminderEnabled ? 'on' : ''}`} role="switch" aria-checked={reminderEnabled} onClick={() => setReminderEnabled(value => !value)}><i /></button>
                 <label className="switch-label" htmlFor="reminder-switch">Remind me daily</label>
                 <span className={`reminder-at${reminderEnabled ? '' : ' off'}`} aria-hidden="true">at</span>
                 <input type="time" value={reminderTime} disabled={!reminderEnabled} onChange={event => setReminderTime(event.target.value)} aria-label="Reminder time" aria-describedby="reminder-hint" />
               </div>
               <p id="reminder-hint" className="setting-hint">{reminderEnabled ? 'Uses your computer’s local time while Trackline is running.' : 'Reminders are off.'}</p>
             </div>
           </section>
           <section className="settings-section" aria-labelledby="settings-appearance">
             <div className="settings-intro"><Palette size={18} aria-hidden="true" /><div><h2 id="settings-appearance">Appearance</h2><p>Choose the working surface that feels most comfortable in your environment.</p></div></div>
             <div className="setting-control">
               <div className="segmented" role="group" aria-label="Color theme"><button aria-pressed={!isDark} onClick={() => setIsDark(false)}><Sun size={15} aria-hidden="true" />Light</button><button aria-pressed={isDark} onClick={() => setIsDark(true)}><Moon size={15} aria-hidden="true" />Dark</button></div>
             </div>
           </section>
         </div>
       </section> : view === 'worklogs' ? <TeamWorklogs scope={teamScope} setScope={setTeamScope} worklogs={team.worklogs} rows={teamRows} isLoading={team.isLoading} error={team.error} onRefresh={team.refresh}
        periodDays={teamPeriodDays} periodLabel={periodLabel} calendarMode={calendarMode} onModeChange={setCalendarMode} workdayHours={workdayHours} todayValue={todayValue}
        focusIncomplete={focusIncomplete} onFocusChange={setFocusIncomplete} hideWeekends={hideWeekends} onHideWeekendsChange={setHideWeekends}
        issues={team.issues} fieldsMissing={{ workType: !ticketFields.config.workTypeField, cost: !ticketFields.config.costField }} /> : <div className="content">
        <section className="calendar-panel" aria-labelledby="calendar-title">
             <div className="calendar-heading"><div><h1 id="calendar-title">{calendarMode === 'week' ? 'Your workweek' : 'Your month'}</h1><p>{isCalendarLoading ? 'Loading your Jira worklogs…' : syncState === 'error' ? syncError : periodTotal ? `${formatHours(periodTotal)} logged${calendarMode === 'month' ? ` across ${loggedDays} ${loggedDays === 1 ? 'day' : 'days'}` : ''} · ${formatHours(Math.max(0, periodTarget - periodTotal))} remaining` : `No Jira time logged for this ${calendarMode}.`}</p></div><div className="calendar-controls"><div className="calendar-options"><label className="calendar-option"><button type="button" role="switch" aria-checked={focusIncomplete} className={`toggle${focusIncomplete ? ' on' : ''}`} onClick={() => setFocusIncomplete(value => !value)}><i /></button>Focus on incomplete days{showFocus && <b aria-label={`${incompleteCount} incomplete ${incompleteCount === 1 ? 'day' : 'days'}`}>{incompleteCount}</b>}</label><label className="calendar-option"><button type="button" role="switch" aria-checked={hideWeekends} className={`toggle${hideWeekends ? ' on' : ''}`} onClick={() => setHideWeekends(value => !value)}><i /></button>Hide weekends</label></div><div className="view-tabs"><button className={calendarMode === 'week' ? 'selected' : ''} aria-pressed={calendarMode === 'week'} onClick={() => setCalendarMode('week')}>Week</button><button className={calendarMode === 'month' ? 'selected' : ''} aria-pressed={calendarMode === 'month'} onClick={() => setCalendarMode('month')}>Month</button></div></div></div>
          <div className="dispatch-legend"><span><i className="route-dot teal" />Logged</span><span><i className="route-dot blue" />Review / meeting</span><span><i className="route-dot coral" />Needs attention</span><button onClick={() => showToast('Issue filters are ready for your Jira data.')}><CircleHelp size={15} />How totals work</button></div>
          {calendarMode === 'week' ? <div className="calendar-shell" style={{ gridTemplateRows: `80px ${hours.length * hourHeight}px`, '--day-count': days.length } as React.CSSProperties}>
            <div className="day-header time-column" />
            {days.map(day => { const total = hoursByDate.get(day.value) ?? 0; const missing = missingHoursFor(new Date(`${day.value}T12:00:00`)); return <div className={`day-header${day.value === todayValue ? ' current-day' : ''}${day.weekend ? ' weekend' : ''}${focusClass(missing)}`} key={day.value}><span>{day.label}</span><strong>{day.date}</strong><small>{formatHours(total)}{day.total > 0 && <b> /{formatHours(day.total)}</b>}{showFocus && missing > 0 && <em className="missing-badge" title={`${formatHours(missing)} missing`}>−{formatHours(missing)}</em>}</small><div className="day-meter"><i style={{ width: `${day.total ? Math.min(100, total / day.total * 100) : total ? 100 : 0}%` }} /></div></div>; })}
            <div className="time-labels">{hours.map(hour => <span style={{ height: hourHeight }} key={hour}>{String(hour).padStart(2, '0')}:00</span>)}</div>
            <div className="grid-area" aria-label="Week time calendar">
              {days.map(day => <div className={`day-lane${day.value === todayValue ? ' today-lane' : ''}${day.weekend ? ' weekend' : ''}${focusClass(missingHoursFor(new Date(`${day.value}T12:00:00`)))}`} key={day.value} onMouseMove={event => { if (isOnWorklog(event)) { if (hoverSlot) setHoverSlot(null); return; } const start = slotFromPointer(event); if (hoverSlot?.date !== day.value || hoverSlot.start !== start) setHoverSlot({ date: day.value, start }); }} onMouseLeave={() => setHoverSlot(null)} onClick={event => { if (isOnWorklog(event)) return; setHoverSlot(null); openLogDialog({ date: day.value, time: slotTime(slotFromPointer(event)) }); }}>{hoverSlot?.date === day.value && <div className="slot-preview" aria-hidden="true" style={{ top: `${(hoverSlot.start - firstHour) * hourHeight}px`, height: `${Math.max(hourHeight - 6, 30)}px` }}><Plus size={12} />{slotTime(hoverSlot.start)}</div>}{hours.map(hour => <div className="hour-line" style={{ height: hourHeight }} key={hour} />)}{placeDayWorklogs(logs.filter(log => log.date === day.value), 42 / hourHeight).map(({ log, column, columns }) => <button className={`worklog ${log.accent}`} onClick={() => setSelected(log)} key={log.id} title={`${log.issue} · ${log.title} · ${formatHours(log.duration)}`} style={{ top: `${(log.start - firstHour) * hourHeight}px`, height: `${Math.max((Math.min(log.start + log.duration, lastHour) - log.start) * hourHeight - 6, 42)}px`, left: `calc(${column * 100 / columns}% + 4px)`, width: `calc(${100 / columns}% - 8px)`, right: 'auto' }}><b>{log.issue}</b><span>{log.title}</span><em>{formatHours(log.duration)}</em></button>)}</div>)}
              {days.some(day => day.value === todayValue) && nowHours >= firstHour && nowHours <= lastHour && <div className="now-line" style={{ top: `${(nowHours - firstHour) * hourHeight}px` }}><span>{nowLabel}</span></div>}
              {isCalendarLoading && <div className="calendar-loading"><span />Loading Jira worklogs</div>}
               {!isCalendarLoading && syncState === 'ready' && !periodLogs.length && <div className="empty-week"><strong>No worklogs this week</strong><span>Your Jira connection is active. Browse to a previous week to see earlier time.</span><button onClick={() => movePeriod(-1)}>Show previous week</button></div>}
            </div>
          </div> : <div className="month-shell">
            <div className="month-grid" style={{ '--day-count': visibleWeekdays.length } as React.CSSProperties} aria-label={`${periodLabel} worklog calendar`}>
              {visibleWeekdays.map(label => <div className="month-weekday" aria-hidden="true" key={label}>{label}</div>)}
              {visibleMonthDays.map(date => {
                const value = localDate(date); const total = hoursByDate.get(value) ?? 0; const dayIssues = issuesByDate.get(value) ?? [];
                const isOutside = date.getMonth() !== monthStart.getMonth(); const isWeekend = date.getDay() % 6 === 0;
                const missing = isOutside ? 0 : missingHoursFor(date);
                return <button className={`month-day${isOutside ? ' outside' : ''}${isWeekend ? ' weekend' : ''}${value === todayValue ? ' today' : ''}${focusClass(missing)}`} key={value} onClick={() => openWeek(date)} aria-label={`${date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}: ${total ? `${formatHours(total)} logged` : 'no time logged'}${showFocus && missing > 0 ? `, ${formatHours(missing)} missing` : ''}. Open week.`}>
                  <span className="month-day-head"><strong>{date.getDate()}</strong>{total > 0 && <em>{formatHours(total)}</em>}</span>
                  <span className="month-meter"><i style={{ width: `${Math.min(100, total / workdayHours * 100)}%` }} /></span>
                  {showFocus && missing > 0 && <span className="missing-badge">{formatHours(missing)} missing</span>}
                  <span className="month-issues">{dayIssues.slice(0, 3).map(item => <span className={`month-chip ${item.accent}`} title={`${item.issue} · ${item.title}`} key={item.issue}><b>{item.issue}</b><small>{formatHours(item.duration)}</small></span>)}{dayIssues.length > 3 && <span className="month-more">+{dayIssues.length - 3} more</span>}</span>
                </button>;
              })}
            </div>
            {isCalendarLoading && <div className="calendar-loading"><span />Loading Jira worklogs</div>}
            {!isCalendarLoading && syncState === 'ready' && !periodLogs.length && <div className="empty-week"><strong>No worklogs this month</strong><span>Your Jira connection is active. Browse to a previous month to see earlier time.</span><button onClick={() => movePeriod(-1)}>Show previous month</button></div>}
          </div>}
        </section>

        <aside className="pulse-panel">
          <div className="pulse-head"><div><span>{pulseLabel} PULSE</span><h2>{formatHours(pulseTotal)} <b>of {formatHours(workdayHours)}</b></h2></div><Clock3 size={22} /></div>
          <div className="pulse-bar"><i style={{ width: `${Math.min(100, pulseTotal / workdayHours * 100)}%` }} /></div>
          <p className="pulse-copy" aria-live="polite">{pulseCopy}</p>
          {canLogPulse && <button className="pulse-action" onClick={() => openLogDialog({ date: pulseValue, time: nextStartTime(pulseValue) })}><Plus size={14} />Log {formatHours(pulseMissing)} for {isPulseToday ? 'today' : new Date(`${pulseValue}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' })}</button>}
          <div className="reminder"><div className="reminder-icon"><Bell size={18} /></div><div><strong>Daily reminder</strong><p>{reminderEnabled ? `${new Date(`1970-01-01T${reminderTime}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · weekdays, local time` : 'Off'}</p></div><button className={`toggle ${reminderEnabled ? 'on' : ''}`} onClick={() => setReminderEnabled(value => !value)} role="switch" aria-checked={reminderEnabled} aria-label="Daily reminder"><i /></button></div>
          {syncState === 'ready' && !isCalendarLoading && <div className="side-section">
            <div className="section-heading"><h3>Needs attention</h3><span className="section-meta">{calendarMode === 'week' ? 'This week' : 'This month'}</span></div>
            {attentionDays.length ? <>{attentionDays.slice(0, 5).map(({ date, missing }) => <div className="attention-row" key={localDate(date)}>
              <span className="issue-glyph coral" />
              <div><strong>{date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</strong><small>{formatHours(missing)} missing</small></div>
              <button onClick={() => openLogDialog({ date: localDate(date), time: nextStartTime(localDate(date)) })} aria-label={`Log time for ${date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`}><Plus size={13} />Log</button>
            </div>)}
            {attentionDays.length > 5 && <button className="attention-more" onClick={() => setFocusIncomplete(true)}>+{attentionDays.length - 5} more · highlight all in the calendar</button>}</>
              : <p className="side-empty"><Check size={14} />Every working day so far is complete.</p>}
          </div>}
          <div className="side-section"><div className="section-heading"><h3>Recently worked</h3>{recentIssues.length > 4 && <button onClick={() => setShowAllRecent(value => !value)} aria-expanded={showAllRecent}>{showAllRecent ? 'Show less' : `View all ${recentIssues.length}`} <ChevronRight size={15} className={showAllRecent ? 'rotated' : ''} /></button>}</div>
            {isCalendarLoading ? <p className="side-empty">Loading issues…</p> : recentIssues.length ? (showAllRecent ? recentIssues : recentIssues.slice(0, 4)).map(item => <button className="issue-row" onClick={() => openIssue(item.issue)} key={item.issue} title={`Open ${item.issue} in Jira`}><span className={`issue-glyph ${item.accent}`} /><div><b>{item.issue}</b><strong>{item.title}</strong></div><em>{formatHours(item.hours)}</em><ExternalLink size={14} /></button>)
              : <p className="side-empty">No time logged this {calendarMode} yet.</p>}
          </div>
          <div className="side-section export-callout"><UsersRound size={18} /><div><h3>Export a calendar</h3><p>Download your logged time, or a team summary with every worklog.</p><button onClick={openExport}>Create CSV <Download size={15} /></button></div></div>
        </aside>
      </div>}
    </section>

    {selected && <div className="popover-backdrop" onClick={() => setSelected(null)}><section className="worklog-detail" onClick={event => event.stopPropagation()}><button className="close" onClick={() => setSelected(null)} aria-label="Close"><X size={18} /></button><span className={`detail-dot ${selected.accent}`} /> <b>{selected.issue}</b><h2>{selected.title}</h2><p>{selected.description}</p><div><Clock3 size={16} />{formatHours(selected.duration)} logged</div><button className="open-issue" onClick={() => openIssue(selected.issue)}>Open issue <ExternalLink size={16} /></button></section></div>}
    {modal === 'log' && <div className="modal-backdrop"><form className="dialog log-dialog" onSubmit={addLog}><button type="button" className="close" onClick={() => setModal(null)} aria-label="Close"><X size={18} /></button><span className="dialog-label">NEW WORKLOG</span><h2>Log time to Jira</h2><p>Entries are saved against the selected Jira issue.</p><div className="issue-field"><span className="field-label" id="issue-label">Jira issue</span>{selectedIssue ? <div className="selected-issue"><div><IssueTypeIcon issue={selectedIssue} /><b>{selectedIssue.key}</b><span>{selectedIssue.summary}</span></div><button type="button" onClick={clearIssue}>Change</button></div> : <div className="issue-picker">
      <div className="issue-filters" role="tablist" aria-label="Issue list">{issueFilters.map(filter => <button type="button" role="tab" aria-selected={issueFilter === filter.value} className={issueFilter === filter.value ? 'selected' : ''} onClick={() => setIssueFilter(filter.value)} key={filter.value}>{filter.label}</button>)}</div>
      <div className="issue-search"><Search size={15} aria-hidden="true" /><input value={issueQuery} onChange={event => setIssueQuery(event.target.value)} onKeyDown={handleIssueKeys} placeholder="Search by summary or issue key" role="combobox" aria-expanded="true" aria-controls="issue-options" aria-autocomplete="list" aria-labelledby="issue-label" aria-activedescendant={flatIssueOptions[activeOption] ? `issue-option-${flatIssueOptions[activeOption].key}` : undefined} autoFocus />{(isSearching || (isIssueListLoading && hasIssueList)) && <span className="mini-spinner" aria-label="Loading issues" />}</div>
      <div className="issue-options" id="issue-options" role="listbox" aria-labelledby="issue-label">
        {!hasIssueList && isIssueListLoading && <p className="issue-status">Loading issues…</p>}
        {issueListError && !hasIssueList && <p className="issue-status error">{issueListError}</p>}
        {issueOptions.remote.length > 0 && issueOptions.local.length > 0 && <div className="issue-group" role="presentation">{issueFilters.find(filter => filter.value === issueFilter)?.label}</div>}
        {issueOptions.local.map((issue, index) => renderIssueOption(issue, index))}
        {issueOptions.remote.length > 0 && <div className="issue-group" role="presentation">All of Jira</div>}
        {issueOptions.remote.map((issue, index) => renderIssueOption(issue, issueOptions.local.length + index))}
        {hasIssueList && !flatIssueOptions.length && <p className="issue-status">{issueQuery.trim().length >= 2 ? (isSearching ? 'Searching Jira…' : 'No matching issues. Try a different word or the full issue key.') : issueQuery.trim() ? 'No matches in this list. Keep typing to search all of Jira.' : 'No issues in this list yet.'}</p>}
      </div>
    </div>}{issueError && <p className="issue-error" role="alert">{issueError}</p>}</div><div className="input-row log-timing"><label>Duration (hours)<input type="number" min="0.25" step="0.25" value={entry.duration} onChange={event => setEntry({ ...entry, duration: event.target.value })} required /></label><label>Day<select value={entry.date} onChange={event => setEntry({ ...entry, date: event.target.value, time: nextStartTime(event.target.value) })}>{Array.from({ length: hideWeekends ? 5 : 7 }, (_, index) => addDays(startOfWeek(new Date(`${entry.date}T12:00:00`)), index)).map(date => <option value={localDate(date)} key={localDate(date)}>{weekdayLabels[(date.getDay() + 6) % 7]} {String(date.getDate()).padStart(2, '0')}</option>)}</select></label><label>Start time<input type="time" value={entry.time} onChange={event => setEntry({ ...entry, time: event.target.value })} required /></label></div><label>Work description<textarea value={entry.description} onChange={event => setEntry({ ...entry, description: event.target.value })} placeholder="What did you work on?" /></label>{saveLogError && <p className="save-error" role="alert">{saveLogError}</p>}<footer><button type="button" className="cancel" onClick={() => setModal(null)}>Cancel</button><button className="primary-button" type="submit" disabled={isSavingLog}>{isSavingLog ? <span className="mini-spinner inline" aria-hidden="true" /> : <Check size={17} />}{isSavingLog ? 'Saving to Jira…' : 'Save worklog'}</button></footer></form></div>}
    {modal === 'export' && <div className="modal-backdrop"><section className="dialog export-dialog"><button className="close" onClick={() => setModal(null)} aria-label="Close"><X size={18} /></button><span className="dialog-label">EXPORT</span><h2>Download logged time</h2><p>CSV files for {periodLabel} are saved to your Downloads folder.</p><div className="scope-options">{[
      { id: 'My calendar', tag: 'ME', text: `Your worklogs for this ${calendarMode}`, disabled: false },
      { id: 'Team worklogs', tag: 'TEAM', text: hasTeamScope ? `${teamScopeText} · per-day summary, every worklog, and per-ticket totals (3 files)` : 'Choose projects or people on the Worklogs page first', disabled: !hasTeamScope },
    ].map(option => <button className={exportScope === option.id ? 'scope-selected' : ''} disabled={option.disabled} onClick={() => setExportScope(option.id)} key={option.id}><span>{option.tag}</span><div><strong>{option.id}</strong><small>{option.text}</small></div><i>{exportScope === option.id && <Check size={15} />}</i></button>)}</div>{exportScope === 'Team worklogs' && team.error && <p className="save-error" role="alert">{team.error}</p>}{exportError && <p className="save-error" role="alert">{exportError}</p>}<footer><button className="cancel" onClick={() => setModal(null)}>Cancel</button><button className="primary-button" onClick={exportCalendar} disabled={isExporting || (exportScope === 'Team worklogs' && (team.isLoading || !!team.error))}>{isExporting || (exportScope === 'Team worklogs' && team.isLoading) ? <span className="mini-spinner inline" aria-hidden="true" /> : <Download size={17} />}{exportScope === 'Team worklogs' && team.isLoading ? 'Loading team worklogs…' : isExporting ? 'Saving…' : 'Download CSV'}</button></footer></section></div>}
    {toast && <div className="toast"><Check size={17} />{toast}</div>}
  </main>;
}
