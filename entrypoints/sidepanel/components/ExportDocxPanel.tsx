import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Storage } from '@/core/storage/storage';
import type { AssetManifest } from '@/core/assets/manifest';
import {
  renderCourseModel,
  writeStoryboardDocx,
  writeStoryboardDocxProse,
  type ResolvedImage,
  type SbCourse,
} from '@/core/storyboard';
import {
  parseManifestCourses,
  type ManifestCourseEntry,
} from '../archive-merge';
import { unwrap } from '../orchestrator/shared';

type DocxFormat = 'prose' | 'storyboard';

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

const RASTER_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

async function resolveImages(
  model: SbCourse,
  storage: Storage,
  courseId: string,
  addLog: (msg: string) => void,
): Promise<Map<string, ResolvedImage>> {
  const images = new Map<string, ResolvedImage>();

  const manifestJson = await storage.readAssetManifest('courses', courseId);
  if (!manifestJson) {
    addLog('No asset manifest found — images will be skipped.');
    return images;
  }
  const manifest: AssetManifest = JSON.parse(manifestJson);
  const keyToEntry = new Map(manifest.assets.map((a) => [a.key, a]));

  const needed = new Set<string>();
  for (const lesson of model.lessons) {
    for (const row of lesson.rows) {
      if (row.image?.key) needed.add(row.image.key);
    }
  }

  let resolved = 0;
  let skipped = 0;
  for (const key of needed) {
    const entry = keyToEntry.get(key);
    if (!entry || !RASTER_EXTS.has(entry.ext)) {
      skipped++;
      continue;
    }
    const fileName = `${entry.hash}.${entry.ext}`;
    const bytes = await storage.readAsset(fileName);
    if (!bytes) {
      skipped++;
      continue;
    }
    const row = model.lessons
      .flatMap((l) => l.rows)
      .find((r) => r.image?.key === key);
    images.set(key, {
      key,
      bytes,
      ext: entry.ext === 'jpeg' ? 'jpg' : entry.ext,
      width: row?.image?.width ?? 800,
      height: row?.image?.height ?? 600,
    });
    resolved++;
  }
  if (resolved > 0 || skipped > 0) {
    addLog(`Images: ${resolved} embedded, ${skipped} skipped (SVG/missing).`);
  }
  return images;
}

interface Props {
  storage: Storage;
  addLog: (msg: string) => void;
}

export function ExportDocxPanel({ storage, addLog }: Props) {
  const [courses, setCourses] = useState<ManifestCourseEntry[] | null>(null);
  const [selected, setSelected] = useState('');
  const [format, setFormat] = useState<DocxFormat>('prose');
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
      const opts = {
        generatedAt: new Date().toISOString(),
        toolVersion: browser.runtime.getManifest().version,
      };
      const model = renderCourseModel(doc, opts);

      let bytes: Uint8Array;
      if (format === 'prose') {
        const images = await resolveImages(model, storage, selected, addLog);
        bytes = writeStoryboardDocxProse(model, images);
      } else {
        bytes = writeStoryboardDocx(model);
      }

      const suffix = format === 'prose' ? 'prose' : 'storyboard';
      const fileName = `${sanitizeFileName(model.title)} — ${suffix}.docx`;
      downloadDocx(fileName, bytes);
      setRendered({ model, fileName });
      addLog(
        `Exported: ${fileName} (${model.lessons.length} lessons, ${model.blockCount} blocks)`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [storage, selected, format, busy, addLog]);

  const stats = useMemo(() => {
    if (!rendered) return null;
    const rows = rendered.model.lessons.flatMap((l) => l.rows);
    return {
      edit: rows.filter((r) => r.fidelity === 'edit').length,
      ro: rows.filter((r) => r.fidelity === 'ro').length,
      images: rows.filter((r) => r.image).length,
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
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as DocxFormat)}
              style={{ width: '100%', marginTop: 4 }}
            >
              <option value="prose">Prose (flowing document)</option>
              <option value="storyboard">Storyboard (table)</option>
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
            {stats.ro} read-only · {stats.images} with images
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
