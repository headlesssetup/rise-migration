import { describe, expect, it } from 'vitest';
import {
  buildBlockTemplateInventory,
  extractBlockTemplates,
} from './block-templates';

const doc = {
  type: 'rise/blockTemplates/FETCH_BLOCK_TEMPLATES',
  payload: [
    {
      id: 't1',
      name: 'Printful Block #1',
      author: 'auth0|abc',
      tenantId: 'tn1',
      items: [{}, {}, {}],
      shared: true,
      createdAt: '2025-03-26T17:47:22.796Z',
      sourceCourseId: 'c1',
      sourceLessonId: 'l1',
      state: 'active',
      profile: { first_name: 'Ada', last_name: 'Lovelace' },
    },
    { id: 't2', name: 'Aardvark', items: [{}], shared: false },
  ],
};

describe('block templates', () => {
  it('extracts the payload array', () => {
    expect(extractBlockTemplates(doc)).toHaveLength(2);
    expect(extractBlockTemplates([{ id: 'x' }])).toHaveLength(1); // bare array
  });

  it('builds rows with blockCount, shared, and resolved author; sorts by name', () => {
    const rows = buildBlockTemplateInventory(extractBlockTemplates(doc));
    expect(rows.map((r) => r.name)).toEqual(['Aardvark', 'Printful Block #1']);
    const p = rows.find((r) => r.id === 't1')!;
    expect(p.blockCount).toBe(3);
    expect(p.shared).toBe(true);
    expect(p.author).toBe('Ada Lovelace'); // from profile
    expect(p.sourceCourseId).toBe('c1');
  });
});
