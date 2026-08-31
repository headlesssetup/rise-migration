import { describe, expect, it } from 'vitest';
import type { Storage } from '@/core/storage/storage';
import { estimateCourses } from './import-run-inputs';

describe('estimateCourses', () => {
  it('loads archived Mondrian graphs before building the estimate plan', async () => {
    const course = {
      course: { id: 'SRC', title: 'Custom block course', lessons: ['L1'] },
      lessons: [
        {
          id: 'L1',
          position: 0,
          type: 'blocks',
          title: 'Lesson',
          items: [
            {
              id: 'B1',
              family: 'mondrian',
              variant: 'mondrian',
              blockumentId: 'M1',
              items: [],
            },
          ],
        },
      ],
    };
    const archive = {
      courseId: 'SRC',
      blockuments: {
        M1: {
          blockuments: { M1: { id: 'M1', title: 'Custom block' } },
          items: {},
        },
      },
    };
    const storage = {
      readCourse: async () => JSON.stringify(course),
      readAssetManifest: async () => JSON.stringify({ assets: [], failed: [] }),
      readBlockuments: async () => JSON.stringify(archive),
    } as unknown as Storage;

    const result = await estimateCourses(storage, ['SRC']);

    expect(result.unreadable).toBe(0);
    expect(result.estimate.seconds).toBeGreaterThan(0);
  });
});
