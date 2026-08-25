'use client';

import { createPortal } from 'react-dom';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { cn } from './cn';

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface DropdownProps {
  options: DropdownOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  tone?: 'pa' | 'legacy';
  className?: string;
  'aria-label'?: string;
}

interface MenuPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: 'bottom' | 'top';
}

const MENU_GAP = 6;
const MENU_MIN_HEIGHT = 112;
const MENU_MAX_HEIGHT = 280;

/** Shared, keyboard-accessible listbox used across Partnership ADS filters. */
export function Dropdown({
  options,
  value,
  defaultValue = '',
  onChange,
  disabled = false,
  required = false,
  name,
  id,
  tone = 'pa',
  className,
  'aria-label': ariaLabel,
}: DropdownProps): ReactNode {
  const generatedId = useId();
  const listboxId = `${id ?? generatedId}-listbox`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const previousValueRef = useRef(value);
  const [open, setOpen] = useState(false);
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const [activeIndex, setActiveIndex] = useState(() =>
    selectedIndex(options, value ?? defaultValue),
  );
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const currentValue = value ?? uncontrolledValue;
  const selected = options.find((option) => option.value === currentValue);
  const selectedIndexValue = selectedIndex(options, currentValue);
  const isLegacy = tone === 'legacy';

  useEffect(() => {
    if (value !== undefined && value !== previousValueRef.current) {
      setActiveIndex(selectedIndex(options, value));
    }
    previousValueRef.current = value;
  }, [options, value]);

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    const rect = trigger.getBoundingClientRect();
    const belowSpace = window.innerHeight - rect.bottom - MENU_GAP;
    const aboveSpace = rect.top - MENU_GAP;
    const shouldOpenAbove = belowSpace < MENU_MIN_HEIGHT && aboveSpace > belowSpace;
    const available = Math.max(
      MENU_MIN_HEIGHT,
      Math.min(MENU_MAX_HEIGHT, shouldOpenAbove ? aboveSpace : belowSpace),
    );
    setPosition({
      left: rect.left,
      top: shouldOpenAbove ? rect.top - MENU_GAP : rect.bottom + MENU_GAP,
      width: rect.width,
      maxHeight: available,
      placement: shouldOpenAbove ? 'top' : 'bottom',
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    const handleViewportChange = () => updatePosition();
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [close, open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const activeOption = menuRef.current?.querySelector<HTMLElement>(
      `[data-option-index="${activeIndex}"]`,
    );
    activeOption?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  function selectOption(option: DropdownOption): void {
    if (option.disabled) return;
    setUncontrolledValue(option.value);
    setActiveIndex(options.findIndex((item) => item.value === option.value));
    onChange?.(option.value);
    close();
    triggerRef.current?.focus();
  }

  function openMenu(nextIndex = selectedIndexValue): void {
    setActiveIndex(nextEnabledIndex(options, nextIndex, 1));
    setOpen(true);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (disabled) return;
    if (
      !open &&
      (event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Enter' ||
        event.key === ' ')
    ) {
      event.preventDefault();
      openMenu(event.key === 'ArrowUp' ? options.length - 1 : selectedIndexValue);
      return;
    }
    if (!open) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) =>
        nextEnabledIndex(options, index, event.key === 'ArrowDown' ? 1 : -1),
      );
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(() =>
        nextEnabledIndex(
          options,
          event.key === 'Home' ? 0 : options.length - 1,
          event.key === 'Home' ? 1 : -1,
        ),
      );
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option !== undefined) selectOption(option);
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      close();
    }
  }

  const menu =
    open && position !== null && typeof document !== 'undefined' ? (
      <div
        ref={menuRef}
        id={listboxId}
        role="listbox"
        aria-label={ariaLabel}
        className={cn(
          'fixed z-[100] overflow-y-auto rounded-pa-md border p-[4px] shadow-pa-2',
          isLegacy ? 'border-border bg-bg-dark' : 'border-pa-border bg-pa-surface',
        )}
        style={{
          left: position.left,
          top: position.placement === 'top' ? 'auto' : position.top,
          bottom: position.placement === 'top' ? window.innerHeight - position.top : 'auto',
          width: position.width,
          maxHeight: position.maxHeight,
        }}
      >
        {options.length === 0 ? (
          <div className="px-pa-3 py-[10px] text-pa-12 text-pa-content-tertiary">No options</div>
        ) : (
          options.map((option, index) => {
            const isSelected = option.value === currentValue;
            const isActive = index === activeIndex;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                id={`${listboxId}-option-${index}`}
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                data-option-index={index}
                disabled={option.disabled}
                onMouseEnter={() => {
                  if (!option.disabled) setActiveIndex(index);
                }}
                onClick={() => {
                  selectOption(option);
                }}
                className={cn(
                  'flex min-h-[36px] w-full items-center justify-between gap-pa-3 rounded-pa-sm px-pa-3 text-left text-pa-13 transition-colors',
                  isActive && !option.disabled
                    ? isLegacy
                      ? 'bg-bg-card'
                      : 'bg-pa-surface-muted'
                    : 'bg-transparent',
                  isSelected && !option.disabled
                    ? isLegacy
                      ? 'font-semibold text-accent'
                      : 'font-semibold text-pa-accent'
                    : isLegacy
                      ? 'text-text'
                      : 'text-pa-content-secondary',
                  option.disabled &&
                    (isLegacy
                      ? 'cursor-not-allowed text-text-muted'
                      : 'cursor-not-allowed text-pa-content-placeholder'),
                )}
              >
                <span className="truncate">{option.label}</span>
                {isSelected && !option.disabled ? (
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                    className={cn('h-4 w-4 shrink-0', isLegacy ? 'text-accent' : 'text-pa-accent')}
                  >
                    <path
                      d="m3.5 8.2 2.8 2.8 6.2-6.2"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    ) : null;

  return (
    <div className={cn('relative w-full', className)}>
      {name ? <input type="hidden" name={name} value={currentValue} required={required} /> : null}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={
          open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
        }
        onClick={() => {
          if (open) close();
          else openMenu();
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          'flex h-[var(--pa-hit-target)] w-full items-center justify-between gap-pa-3 text-left',
          'rounded-pa-md border px-[14px] text-pa-13 outline-none',
          isLegacy
            ? 'border-border bg-bg-card text-text'
            : 'border-pa-border bg-pa-surface text-pa-content',
          'transition-[border-color,box-shadow,background-color] duration-[120ms]',
          open
            ? isLegacy
              ? 'border-accent shadow-[0_0_0_3px_var(--color-accent-dim)]'
              : 'border-pa-ring shadow-[0_0_0_3px_rgba(8,145,178,0.16)]'
            : isLegacy
              ? 'hover:border-accent'
              : 'hover:border-pa-border-strong',
          isLegacy
            ? 'focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--color-accent-dim)] disabled:bg-bg-card'
            : 'focus-visible:border-pa-ring focus-visible:shadow-[0_0_0_3px_rgba(8,145,178,0.16)] disabled:bg-pa-surface-muted',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        <span
          className={cn(
            'truncate',
            selected === undefined &&
              (isLegacy ? 'text-text-muted' : 'text-pa-content-placeholder'),
          )}
        >
          {selected?.label ?? 'Select an option'}
        </span>
        <svg
          viewBox="0 0 10 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
          className={cn(
            'h-[6px] w-[10px] shrink-0 transition-transform duration-[120ms]',
            isLegacy ? 'text-text-dim' : 'text-pa-content-tertiary',
            open && 'rotate-180',
          )}
        >
          <path d="M1 1l4 4 4-4" strokeLinecap="round" />
        </svg>
      </button>
      {typeof document !== 'undefined' && menu !== null ? createPortal(menu, document.body) : null}
    </div>
  );
}

function selectedIndex(options: DropdownOption[], value: string): number {
  const index = options.findIndex((option) => option.value === value && !option.disabled);
  return index >= 0 ? index : nextEnabledIndex(options, 0, 1);
}

function nextEnabledIndex(options: DropdownOption[], start: number, direction: 1 | -1): number {
  if (options.length === 0) return -1;
  let index = Math.min(Math.max(start, 0), options.length - 1);
  for (let step = 0; step < options.length; step += 1) {
    if (!options[index]?.disabled) return index;
    index = (index + direction + options.length) % options.length;
  }
  return -1;
}
