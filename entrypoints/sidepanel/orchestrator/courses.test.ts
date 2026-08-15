import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Storage } from '@/core/storage/storage';
import type { BackgroundResponse } from '@/shared/messaging';
import { rpc } from '../rpc';
import { exportCourses } from './courses';
import type { ProgressEvent } from './shared';

vi.mock('../rpc', () => ({ rpc: vi.fn() }));
const rpcMock = vi.mocked(rpc);
const noDelay = { baseMs: 0, jitterMs: 0 };

function store() {
  const written: string[] = [];
  const storage = {
    hasCourse: async () => false,
    writeCourse: async (id: string) => void written.push(id),
  } as unknown as Storage;
  return { storage, written };
}

function ok(id: string): BackgroundResponse {
  return {
    type: 'COURSE_RESULT',
    result: { ok: true, status: 200, data: { raw: JSON.stringify({ id }) } },
  };
}

describe('exportCourses auth recovery boundary', () => {
  beforeEach(() => rpcMock.mockReset());

  it('stops the queue after background automatic recovery is exhausted', async () => {
    rpcMock.mockResolvedValueOnce(ok('a')).mockResolvedValueOnce({
      type: 'COURSE_RESULT',
      result: {
        ok: false,
        status: 403,
        code: 'AUTH_REQUIRED',
        error: 'Automatic course-editor recovery did not produce a new token.',
      },
    });
    const { storage, written } = store();
    const events: ProgressEvent[] = [];

    const result = await exportCourses(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      storage,
      (event) => events.push(event),
      noDelay,
    );

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(written).toEqual(['a']);
    expect(result).toEqual({
      saved: 1,
      skipped: 0,
      failed: ['b'],
      stopped: { courseId: 'b', remaining: 1, reason: expect.stringContaining('recovery') },
    });
    expect(
      events.some(
        (event) =>
          event.kind === 'log' &&
          event.message.includes('1 course(s) were left untouched and can be resumed safely'),
      ),
    ).toBe(true);
  });

  it('continues after an ordinary course-specific failure', async () => {
    rpcMock
      .mockResolvedValueOnce({
        type: 'COURSE_RESULT',
        result: { ok: false, status: 500, error: 'course-specific server error' },
      })
      .mockResolvedValueOnce(ok('b'));
    const { storage, written } = store();

    const result = await exportCourses(
      [{ id: 'a' }, { id: 'b' }],
      storage,
      () => {},
      noDelay,
    );

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(written).toEqual(['b']);
    expect(result).toEqual({ saved: 1, skipped: 0, failed: ['a'] });
  });
});
