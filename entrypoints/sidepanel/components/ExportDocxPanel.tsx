import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Storage } from '@/core/storage/storage';
import { renderStoryboardDocx, type SbCourse } from '@/core/storyboard';
import {
  parseManifestCourses,
  type ManifestCourseEntry,
} from '../archive-merge';
import { unwrap } from '../orchestrator/shared';

function sanitizeFileName(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|]/g, '·')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'course'
  );
}

function downloadDocx(name: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

interface Props {
  storage: Storage;
  addLog: (msg: string) => void;
}

export function ExportDocxPanel({ storage, addLog }: Props) {
  const [courses, setCourses] = useState<ManifestCourseEntry[] | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState<{
    model: SbCourse;
    fileName: string;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const fromManifest = parseManifestCourses(
          await storage.readManifest(),
        );
        if (fromManifest.length > 0) {
          setCourses(fromManifest);
          return;
        }
        setCourses(
          (await storage.listSaved()).map((id) => ({ id })),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setCourses([]);
      }
    })();
  }, [storage]);

  const generate = useCallback(async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    setRendered(null);
    try {
      const raw = await storage.readCourse(selected);
      if (!raw)
        throw new Error(`courses/${selected}.json not found in archive.`);
      const doc = unwrap(raw);
      const { model, bytes } = renderStoryboardDocx(doc, {
        generatedAt: new Date().toISOString(),
        toolVersion: browser.runtime.getManifest().version,
      });
      const fileName = `${sanitizeFileName(model.title)} — storyboard.docx`;
      downloadDocx(fileName, bytes);
      setRendered({ model, fileName });
      addLog(
        `SBDOC exported: ${fileName} (${model.lessons.length} lessons, ${model.blockCount} blocks)`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [storage, selected, busy, addLog]);

  const stats = useMemo(() => {
    if (!rendered) return null;
    const rows = rendered.model.lessons.flatMap((l) => l.rows);
    return {
      edit: rows.filter((r) => r.fidelity === 'edit').length,
      ro: rows.filter((r) => r.fidelity === 'ro').length,
    };
  }, [rendered]);

  return (
    <>
      <section className="card">
        <h2>Course</h2>
        {courses === null && <p className="hint">Reading archive…</p>}
        {courses !== null && courses.length === 0 && (
          <p className="hint">
            No courses in the archive — export courses first (Archive account →
            C).
          </p>
        )}
        {courses !== null && courses.length > 0 && (
          <>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="">— select a course —</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {typeof c.title === 'string' && c.title !== ''
                    ? c.title
                    : c.id}
                </option>
              ))}
            </select>
            <button
              onClick={generate}
              disabled={!selected || busy}
              style={{ marginTop: 8 }}
            >
              {busy ? 'Generating…' : 'Generate .docx'}
            </button>
          </>
        )}
        {error && (
          <p className="hint" style={{ color: '#c00' }}>
            ⚠ {error}
          </p>
        )}
      </section>

      {rendered && stats && (
        <section className="card">
          <h2>Result</h2>
          <p>
            ✔ Downloaded: <b>{rendered.fileName}</b>
          </p>
          <p className="hint">
            {rendered.model.lessons.length} lessons ·{' '}
            {rendered.model.blockCount} blocks · {stats.edit} editable ·{' '}
            {stats.ro} read-only
            {rendered.model.locale
              ? ` · language: ${rendered.model.locale}`
              : ''}
          </p>
          {rendered.model.flags.length > 0 && (
            <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 12 }}>
              {rendered.model.flags.map((f, i) => (
                <li key={i} style={{ color: '#c00' }}>
                  ⚠ {f}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
