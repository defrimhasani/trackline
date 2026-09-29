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
