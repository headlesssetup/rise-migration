import { describe, expect, it } from 'vitest';
import { risePlaneFromUrl, type BackgroundRequest, type TabPin } from './messaging';

describe('risePlaneFromUrl', () => {
  it('maps each Rise plane host to its plane', () => {
    expect(risePlaneFromUrl('https://rise.articulate.com/authoring/abc')).toBe('us');
    expect(risePlaneFromUrl('https://rise.eu.articulate.com/authoring/abc')).toBe('eu');
  });

  it('returns null for anything that is not a Rise tab', () => {
    // A tab navigated away from Rise must NEVER read as a plane: the pin check
    // and the per-plane bearer both key off this.
    expect(risePlaneFromUrl('https://articulate.com/')).toBeNull();
    expect(risePlaneFromUrl('https://evil-rise.articulate.com.example/')).toBeNull();
    expect(risePlaneFromUrl('http://rise.articulate.com/')).toBeNull();
    expect(risePlaneFromUrl(undefined)).toBeNull();
    expect(risePlaneFromUrl('')).toBeNull();
  });
});

describe('pinned request contract', () => {
  const pin: TabPin = { pinnedTabId: 7, expectedPlane: 'eu' };

  it('lets any request carry a pin while staying discriminable by type', () => {
    const write: BackgroundRequest = {
      type: 'RELAY_WRITE',
      spec: { url: '/x', method: 'POST', label: 'x' },
      pin,
    };
    const read: BackgroundRequest = { type: 'GET_COURSE', courseId: 'c1', pin };
    const unpinned: BackgroundRequest = { type: 'SEARCH_COURSES', page: 0 };

    // Narrowing by `type` still works through the pin intersection.
    if (read.type === 'GET_COURSE') expect(read.courseId).toBe('c1');
    expect(write.pin).toEqual({ pinnedTabId: 7, expectedPlane: 'eu' });
    expect(unpinned.pin).toBeUndefined();
  });
});
