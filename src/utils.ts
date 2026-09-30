export const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const addDays = (date: Date, amount: number) => { const next = new Date(date); next.setDate(date.getDate() + amount); return next; };
export const weekdayLabels = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
export const formatHours = (hours: number) => `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
export const hoursNumber = (hours: number) => Number(hours.toFixed(2));
export const readableError = (error: unknown) => typeof error === 'string' ? error : 'Trackline could not reach its desktop service. Restart the app and try again.';
export const isWeekend = (date: Date) => date.getDay() % 6 === 0;
export const daysBetween = (start: string, end: string) => {
  const dates: Date[] = [];
  for (let date = new Date(`${start}T12:00:00`); localDate(date) < end; date = addDays(date, 1)) dates.push(date);
  return dates;
};
export const toCsv = (rows: (string | number)[][]) => `\uFEFF${rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n')}`;

/**
 * Parses a Jira-style duration into minutes: "30m", "2h", "1h 30m", "1h30m", "1.5h", "1:30",
 * "1d" (one workday) or a plain number of hours ("1.5"). Returns null when the text isn't a duration.
 */
export const parseDuration = (input: string, workdayHours = 8): number | null => {
  const text = input.trim().toLowerCase().replace(/,/g, '.');
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 60) || null;
  const clock = text.match(/^(\d+):([0-5]\d)$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]) || null;
  const units: Record<string, number> = { d: workdayHours * 60, h: 60, m: 1 };
  let minutes = 0;
  const rest = text.replace(/(\d+(?:\.\d+)?)\s*(d|h|m)(?![a-z])\s*/g, (_, value: string, unit: string) => { minutes += Number(value) * units[unit]; return ''; });
  return rest.trim() ? null : Math.round(minutes) || null;
};

/** Formats minutes the way Jira shows time: "45m", "2h", "1h 30m". */
export const formatDuration = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return hours && rest ? `${hours}h ${rest}m` : hours ? `${hours}h` : `${rest}m`;
};
