import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CalendarRange, ChevronLeft, ChevronRight } from 'lucide-react';
import { localDate, weekdayLabels } from './utils';

export type DateRange = { start: string; end: string };
type RangePickerProps = { value: DateRange; defaultRange: DateRange; defaultLabel: string; onChange: (range: DateRange) => void };

const parse = (value: string) => new Date(`${value}T12:00:00`);
const format = (value: string, withYear = false) => parse(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
const daysAgo = (days: number) => { const date = new Date(); date.setDate(date.getDate() - days); return localDate(date); };

export function RangePicker({ value, defaultRange, defaultLabel, onChange }: RangePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [month, setMonth] = useState(() => { const date = parse(value.start); return new Date(date.getFullYear(), date.getMonth(), 1); });
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const todayValue = localDate(new Date());
  const now = new Date();

  useLayoutEffect(() => {
    if (!isOpen || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const width = Math.min(500, window.innerWidth - 16);
    setPosition({ top: Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - 340)), left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutside = (event: MouseEvent) => { const target = event.target as Node; if (!containerRef.current?.contains(target) && !popoverRef.current?.contains(target)) setIsOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setIsOpen(false); buttonRef.current?.focus(); } };
    document.addEventListener('mousedown', closeOnOutside);
    window.addEventListener('keydown', closeOnEscape, true);
    return () => { document.removeEventListener('mousedown', closeOnOutside); window.removeEventListener('keydown', closeOnEscape, true); };
  }, [isOpen]);

  const open = () => {
    const date = parse(value.start);
    setMonth(new Date(date.getFullYear(), date.getMonth(), 1)); setAnchor(null); setHover(null); setIsOpen(true);
  };
  const apply = (range: DateRange) => { onChange(range); setIsOpen(false); buttonRef.current?.focus(); };
  const pick = (day: string) => {
    if (!anchor) { setAnchor(day); return; }
    apply(day < anchor ? { start: day, end: anchor } : { start: anchor, end: day });
  };

  const presets: { label: string; range: DateRange }[] = [
    { label: defaultLabel, range: defaultRange },
    { label: 'Last 7 days', range: { start: daysAgo(6), end: todayValue } },
    { label: 'Last 30 days', range: { start: daysAgo(29), end: todayValue } },
    { label: 'This month', range: { start: localDate(new Date(now.getFullYear(), now.getMonth(), 1)), end: localDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)) } },
    { label: 'Last month', range: { start: localDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)), end: localDate(new Date(now.getFullYear(), now.getMonth(), 0)) } },
    { label: 'Last 3 months', range: { start: localDate(new Date(now.getFullYear(), now.getMonth() - 2, 1)), end: todayValue } },
    { label: 'This year', range: { start: `${now.getFullYear()}-01-01`, end: `${now.getFullYear()}-12-31` } },
  ];

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const cells = Array.from({ length: 42 }, (_, index) => new Date(month.getFullYear(), month.getMonth(), index - offset + 1));
  const live: DateRange = anchor ? { start: hover && hover < anchor ? hover : anchor, end: hover && hover > anchor ? hover : anchor } : value;
  const sameRange = (a: DateRange, b: DateRange) => a.start === b.start && a.end === b.end;
  const summary = value.start === value.end ? format(value.start, true) : `${format(value.start, parse(value.start).getFullYear() !== parse(value.end).getFullYear())} – ${format(value.end, true)}`;

  return <div className="range-picker" ref={containerRef}>
    <button ref={buttonRef} type="button" className="range-trigger" onClick={() => isOpen ? setIsOpen(false) : open()} aria-haspopup="dialog" aria-expanded={isOpen}>
      <CalendarRange size={15} aria-hidden="true" /><span>{summary}</span>
    </button>
    {isOpen && createPortal(<div ref={popoverRef} className="range-popover" role="dialog" aria-label="Choose a date range" style={position}>
      <ul className="range-presets">{presets.map(preset => <li key={preset.label}>
        <button type="button" className={sameRange(preset.range, value) ? 'selected' : ''} onClick={() => apply(preset.range)}>{preset.label}</button>
      </li>)}</ul>
      <div className="range-calendar">
        <div className="range-month-head">
          <button type="button" onClick={() => setMonth(current => new Date(current.getFullYear(), current.getMonth() - 1, 1))} aria-label="Previous month"><ChevronLeft size={16} /></button>
          <strong aria-live="polite">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong>
          <button type="button" onClick={() => setMonth(current => new Date(current.getFullYear(), current.getMonth() + 1, 1))} aria-label="Next month"><ChevronRight size={16} /></button>
        </div>
        <div className="range-days" onMouseLeave={() => setHover(null)}>
          {weekdayLabels.map(label => <span key={label} className="range-weekday">{label.slice(0, 2)}</span>)}
          {cells.map(date => {
            const day = localDate(date);
            const inRange = day >= live.start && day <= live.end;
            const classes = ['range-day', date.getMonth() !== month.getMonth() && 'outside', day === todayValue && 'today', inRange && 'in-range', day === live.start && 'edge-start', day === live.end && 'edge-end'].filter(Boolean).join(' ');
            return <button type="button" key={day} className={classes} onClick={() => pick(day)} onMouseEnter={() => setHover(day)} aria-pressed={inRange && (day === live.start || day === live.end)}
              aria-label={date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}>{date.getDate()}</button>;
          })}
        </div>
        <p className="range-hint">{anchor ? `Starting ${format(anchor)} — pick the end date` : 'Pick a start date, then an end date'}</p>
      </div>
    </div>, document.body)}
  </div>;
}
