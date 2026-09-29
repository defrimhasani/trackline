import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';

type MonthPickerProps = { value: Date; label: string; onChange: (month: Date) => void };

export function MonthPicker({ value, label, onChange }: MonthPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [year, setYear] = useState(value.getFullYear());
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const today = new Date();

  useEffect(() => { if (isOpen) setYear(value.getFullYear()); }, [isOpen]);
  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutside = (event: MouseEvent) => { if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setIsOpen(false); buttonRef.current?.focus(); } };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('mousedown', closeOnOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, [isOpen]);

  const choose = (month: Date) => { onChange(month); setIsOpen(false); buttonRef.current?.focus(); };

  return <div className="month-picker" ref={containerRef}>
    <button ref={buttonRef} type="button" className="period-button" onClick={() => setIsOpen(open => !open)} aria-haspopup="dialog" aria-expanded={isOpen}>{label}<ChevronDown size={15} aria-hidden="true" /></button>
    {isOpen && <div className="month-popover" role="dialog" aria-label="Choose a month">
      <div className="month-popover-head">
        <button type="button" onClick={() => setYear(current => current - 1)} aria-label="Previous year"><ChevronLeft size={16} /></button>
        <strong aria-live="polite">{year}</strong>
        <button type="button" onClick={() => setYear(current => current + 1)} aria-label="Next year"><ChevronRight size={16} /></button>
      </div>
      <div className="month-options">{Array.from({ length: 12 }, (_, month) => {
        const date = new Date(year, month, 1);
        const isSelected = year === value.getFullYear() && month === value.getMonth();
        const isCurrent = year === today.getFullYear() && month === today.getMonth();
        return <button type="button" key={month} className={`${isSelected ? 'selected' : ''}${isCurrent ? ' current' : ''}`} aria-pressed={isSelected} autoFocus={isSelected} onClick={() => choose(date)} aria-label={date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}>{date.toLocaleDateString(undefined, { month: 'short' })}</button>;
      })}</div>
      <button type="button" className="month-this" onClick={() => choose(new Date(today.getFullYear(), today.getMonth(), 1))}>This month</button>
    </div>}
  </div>;
}
