// Optional-media parity (handover 2026-08-31, blocker 4): capture-confirmed
// OPTIONAL authoring provenance (distinct video `inputKey`, `media.tmp`,
// `originalImage`, inactive image variant) is blanked WITHOUT a manual flag —
// and that intentional omission must never produce a blocking `media-missing`
// (the CRM course carries exactly six such keys, all 403 at source).
import { describe, it, expect } from 'vitest';
import { verifyParity } from './verify';
import type { GetCourseDocument } from '@/shared/types/rise';

// The CRM six-key shape: 2× media.tmp, 2× originalImage, 2× video inputKey.
const OPTIONAL_KEYS = [
  'rise/courses/SRC/tmp-1.png',
  'rise/courses/SRC/tmp-2.png',
  'rise/courses/SRC/orig-1.png',
  'rise/courses/SRC/orig-2.png',
  'rise/courses/SRC/input-1.mp4',
  'rise/courses/SRC/input-2.mp4',
];

function sourceDoc(): GetCourseDocument {
  return {
    course: {
      id: 'SRC',
      title: 'CRM',
      media: { tmp: { image: { key: 'rise/courses/SRC/tmp-1.png' } } },
    },
    lessons: [
      {
        id: 'L1',
        type: 'blocks',
        title: 'L',
        items: [
          {
            id: 'cblk1aaaaaaaaaaaaaaaaaaaa',
            family: 'image',
            variant: 'hero',
            items: [
              {
                id: 'citm1aaaaaaaaaaaaaaaaaaaa',
                media: {
                  tmp: { image: { key: 'rise/courses/SRC/tmp-2.png' } },
                  image: {
                    key: 'rise/courses/NEW-OK/kept.png',
                    originalImage: { key: 'rise/courses/SRC/orig-1.png' },
                  },
                },
              },
            ],
          },
          {
            id: 'cblk2aaaaaaaaaaaaaaaaaaaa',
            family: 'multimedia',
            variant: 'video',
            items: [
              {
                id: 'citm2aaaaaaaaaaaaaaaaaaaa',
                media: {
                  video: { key: 'rise/courses/NEW-OK/video.mp4', inputKey: 'rise/courses/SRC/input-1.mp4' },
                  image: { originalImage: { key: 'rise/courses/SRC/orig-2.png' } },
                },
                extra: { inputKey: 'rise/courses/SRC/input-2.mp4' },
              },
            ],
          },
        ],
      },
    ],
  } as unknown as GetCourseDocument;
}

/** The target: what the import deliberately shipped — optional slots blanked,
 *  active media remapped to the new course's keys. */
function targetDoc(): GetCourseDocument {
  const t = JSON.parse(
    JSON.stringify(sourceDoc()).split('rise/courses/SRC/tmp-1.png').join('')
      .split('rise/courses/SRC/tmp-2.png').join('')
      .split('rise/courses/SRC/orig-1.png').join('')
      .split('rise/courses/SRC/orig-2.png').join('')
      .split('rise/courses/SRC/input-1.mp4').join('')
      .split('rise/courses/SRC/input-2.mp4').join(''),
  ) as GetCourseDocument;
  (t.course as Record<string, unknown>).id = 'NEW';
  return t;
}

describe('verifyParity — optional provenance omissions (CRM six-key regression)', () => {
  it('does NOT block when the six optional keys were intentionally dropped', () => {
    const p = verifyParity(sourceDoc(), targetDoc(), [], OPTIONAL_KEYS);
    const mediaIssues = p.issues.filter((i) => i.kind === 'media-missing');
    expect(mediaIssues).toEqual([]);
    expect(p.ok).toBe(true);
  });

  it('still BLOCKS when a required (non-listed) key is missing on the target', () => {
    // Same omissions, but the ACTIVE image key vanished too — that is a loss.
    const broken = JSON.parse(
      JSON.stringify(targetDoc()).split('rise/courses/NEW-OK/kept.png').join(''),
    ) as GetCourseDocument;
    const p = verifyParity(sourceDoc(), broken, [], OPTIONAL_KEYS);
    expect(p.issues.some((i) => i.kind === 'media-missing')).toBe(true);
    expect(p.ok).toBe(false);
  });

  it('without the optional list the same omissions DO block (the old defect)', () => {
    const p = verifyParity(sourceDoc(), targetDoc(), []);
    expect(p.issues.some((i) => i.kind === 'media-missing')).toBe(true);
  });
});
