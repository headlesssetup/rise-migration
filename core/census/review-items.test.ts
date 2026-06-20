import { describe, expect, it } from 'vitest';
import {
  buildReviewItemsInventory,
  extractReviewItems,
} from './review-items';

const doc = {
  items: [
    {
      id: 'r1',
      product: 'storyline',
      project_id: 'p1',
      title: 'Mighty course',
      source: { course_id: 'c1', slides: [{}, {}, {}], mighty_bundle: true },
      package: { key: '', md5_checksum: 'd41d8cd98f00b204e9800998ecf8427e' },
    },
    {
      id: 'r2',
      product: 'storyline',
      project_id: 'p2',
      title: 'Real Storyline',
      source: { course_id: 'c2', slides: [{}], mighty_bundle: false },
      package: { key: 'story_content/abc.zip', md5_checksum: 'abc' },
    },
  ],
};

describe('review items', () => {
  it('extracts item objects tolerantly', () => {
    expect(extractReviewItems(doc)).toHaveLength(2);
    expect(extractReviewItems([{ id: 'x', source: {} }])).toHaveLength(1);
  });

  it('flags Mighty bundles, slide count, and downloadable package; Mighty sorts first', () => {
    const rows = buildReviewItemsInventory(extractReviewItems(doc));
    expect(rows[0]!.id).toBe('r1'); // mighty first
    const m = rows.find((r) => r.id === 'r1')!;
    expect(m.mighty).toBe(true);
    expect(m.slideCount).toBe(3);
    expect(m.hasDownloadablePackage).toBe(false);
    expect(m.sourceCourseId).toBe('c1');

    const s = rows.find((r) => r.id === 'r2')!;
    expect(s.mighty).toBe(false);
    expect(s.hasDownloadablePackage).toBe(true);
  });
});
