import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FolderControls } from './FolderControls';

const render = (overrides: Partial<Parameters<typeof FolderControls>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(FolderControls, {
      folderName: null,
      pendingName: null,
      connected: false,
      busy: false,
      onPick: vi.fn(),
      onReconnect: vi.fn(),
      onForget: vi.fn(),
      ...overrides,
    }),
  );

describe('FolderControls', () => {
  it('never traps a remembered folder behind Reconnect only', () => {
    const html = render({ folderName: 'old archive', pendingName: 'old archive' });
    expect(html).toContain('Reconnect: old archive');
    expect(html).toContain('Choose different folder…');
    expect(html).toContain('Forget folder');
  });

  it('offers change and forget for a connected folder', () => {
    const html = render({ folderName: 'archive', connected: true });
    expect(html).not.toContain('Reconnect');
    expect(html).toContain('Choose different folder…');
    expect(html).toContain('Forget folder');
  });

  it('shows a single picker action when nothing is remembered', () => {
    const html = render();
    expect(html).toContain('Pick archive folder…');
    expect(html).not.toContain('Reconnect');
    expect(html).not.toContain('Forget folder');
  });
});
