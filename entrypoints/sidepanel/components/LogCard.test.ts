import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LogCard } from './LogCard';

const render = (log: string[]) =>
  renderToStaticMarkup(
    createElement(LogCard, {
      log,
      copied: false,
      copyLog: vi.fn(),
      clearLog: vi.fn(),
      status: null,
      logRef: { current: null },
      onLogScroll: vi.fn(),
    }),
  );

describe('LogCard', () => {
  it('renders the All / Problems / Errors filter with All active by default', () => {
    const html = render(['▶ Op', '✓ fine', 'FAILED "x" (id): boom']);
    expect(html).toContain('aria-label="Log filter"');
    expect(html).toMatch(/class="log-filter-btn active"[^>]*aria-pressed="true">All</);
    expect(html).toContain('>Problems<');
    expect(html).toContain('>Errors<');
    // Unfiltered: every line is rendered, colour-classified.
    expect(html).toContain('log-line log-ok');
    expect(html).toContain('log-line log-error');
  });
});
