// Shared plumbing for the Import view's step sections — split out of
// ImportView.tsx (v0.9.0 restructure): the Stop controller contract, the
// common section props, the collapsible step card, and the filterable-list
// helpers. Sections were file-private before; only ImportView consumes them,
// so there is no re-export shim.

import type * as React from 'react';
import type { AccountIdentity } from '@/core/import';
import type { Storage } from '@/core/storage/storage';
import type { ProgressEvent } from '../../orchestrator';

export interface ArchiveCourse {
  id: string;
  title?: string;
}

/** Cooperative-cancel controller for the Stop button, shared by the sections. */
export interface StopController {
  /** Read synchronously by the orchestrator between courses/banks/steps. */
  shouldStop: () => boolean;
  /** Flip the flag (Stop pressed) — the run halts at the next safe checkpoint. */
  request: () => void;
  /** Clear the flag at the start of a fresh run. */
  reset: () => void;
  /** True once Stop has been pressed for the current run (for the button label). */
  requested: boolean;
}

export interface SectionProps {
  storage: Storage | null;
  target: AccountIdentity | undefined;
  override: boolean;
  liveOk: boolean;
  running: boolean;
  setRunning: (b: boolean) => void;
  onEvent: (e: ProgressEvent) => void;
  logBreak: (label?: string) => void;
  stop: StopController;
}

export const STEP_STYLE: React.CSSProperties = {
  border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
  borderRadius: 8,
  padding: 10,
  marginTop: 10,
};

/** A collapsible step card. Built on the native `<details>`/`<summary>` element
 *  (accessible + keyboard-toggleable for free, no React state to drift); the
 *  up/down triangle is drawn by `details.step > summary` in style.css, never the
 *  1px native marker. Open by default (steps run top-to-bottom), foldable once
 *  done. `defaultOpen` is constant per card, so passing it as `open` leaves the
 *  element effectively uncontrolled — the user can still toggle it freely. */
export function CollapsibleStep({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="step" style={STEP_STYLE} open={defaultOpen}>
      <summary>
        <h3 style={{ margin: 0, display: 'inline' }}>{title}</h3>
      </summary>
      {children}
    </details>
  );
}

// --- A) Account settings ------------------------------------------------------


export function FilterRow({
  value,
  onChange,
  placeholder,
  selected,
  shown,
  total,
  onSelectAll,
  onClear,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  selected: number;
  shown: number;
  total: number;
  /** Select all currently-visible (filtered) rows. */
  onSelectAll: () => void;
  onClear: () => void;
}) {
  return (
    <>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '4px 8px',
          margin: '4px 0',
          font: 'inherit',
          borderRadius: 6,
          border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
          background: 'transparent',
          color: 'inherit',
        }}
      />
      <div className="row" style={{ margin: '4px 0' }}>
        <span className="hint">
          {selected} selected · {value ? `${shown} of ${total} shown` : `${total} total`}
        </span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button onClick={onSelectAll} disabled={shown === 0}>
            {value ? `Select ${shown} shown` : 'Select all'}
          </button>
          <button onClick={onClear} disabled={selected === 0}>
            Clear
          </button>
        </span>
      </div>
    </>
  );
}

export function filterByName<T>(items: T[], name: (t: T) => string, q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((it) => name(it).toLowerCase().includes(needle));
}

export function toggle(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  next.has(id) ? next.delete(id) : next.add(id);
  return next;
}

/** Add every id in `ids` (the currently-visible rows) to the selection. */
export function selectAll(set: Set<string>, ids: string[]): Set<string> {
  const next = new Set(set);
  for (const id of ids) next.add(id);
  return next;
}

