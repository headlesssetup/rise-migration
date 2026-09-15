// The Review page's STYLE card (v0.9.12): harvest a style profile from a
// rise-export archive of the designer's finished courses (`./style-store.ts`),
// pick one of the stored profiles, and connect the read-only asset folder
// whose files the blueprint names (`./asset-folder.ts`). `useStyle` owns the
// state and hands the approve step what it needs (selected profile, folder
// listing, the blueprint's file check); `StyleCard` renders it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CourseBlueprint } from '@/core/creator';
import type { StyleProfile } from '@/core/style';
import {
  ASSET_FOLDER_KEY,
  STYLE_SOURCE_FOLDER_KEY,
  clearDirHandle,
  loadDirHandle,
  saveDirHandle,
  verifyPermission,
  verifyReadPermission,
} from '../sidepanel/folder-store';
import { blueprintFileNames, listFolderFiles, type FolderListing } from './asset-folder';
import {
  harvestFromArchive,
  listArchiveCourses,
  listStyles,
  type ArchiveCourseRow,
  type StoredStyle,
} from './style-store';

type DirPicker = (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}
export function pickDirectory(mode: 'read' | 'readwrite'): Promise<FileSystemDirectoryHandle> {
  const picker = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;
  if (!picker) throw new Error('File System Access API is not available in this browser.');
  return picker({ mode });
}

export interface StyleState {
  styles: StoredStyle[];
  styleFile: string;
  setStyleFile: (f: string) => void;
  selectedStyle: StyleProfile | null;
  styleSource: FileSystemDirectoryHandle | null;
  sourceCourses: ArchiveCourseRow[] | null;
  sourceSelected: string[];
  setSourceSelected: (fn: (cur: string[]) => string[]) => void;
  harvestName: string;
  setHarvestName: (v: string) => void;
  harvesting: boolean;
  harvestReport: string[] | null;
  styleError: string | null;
  assetFolder: FileSystemDirectoryHandle | null;
  assetNeedsGrant: boolean;
  assetListing: FolderListing | null;
  /** The blueprint's file names vs. the connected folder (null without a blueprint). */
  fileCheck: { names: string[]; missing: string[] } | null;
  connectAssetFolder: () => Promise<void>;
  /** `repick` forces the directory picker even when a source is remembered. */
  connectStyleSource: (repick?: boolean) => Promise<void>;
  harvest: () => Promise<void>;
}

export function useStyle(
  folder: FileSystemDirectoryHandle | null,
  folderReady: boolean,
  blueprint: CourseBlueprint | null,
): StyleState {
  const [styles, setStyles] = useState<StoredStyle[]>([]);
  const [styleFile, setStyleFile] = useState('');
  const [styleSource, setStyleSource] = useState<FileSystemDirectoryHandle | null>(null);
  const [sourceCourses, setSourceCourses] = useState<ArchiveCourseRow[] | null>(null);
  const [sourceSelected, setSourceSelectedRaw] = useState<string[]>([]);
  const [harvestName, setHarvestName] = useState('');
  const [harvesting, setHarvesting] = useState(false);
  const [harvestReport, setHarvestReport] = useState<string[] | null>(null);
  const [styleError, setStyleError] = useState<string | null>(null);
  const [assetFolder, setAssetFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [assetNeedsGrant, setAssetNeedsGrant] = useState(false);
  const [assetListing, setAssetListing] = useState<FolderListing | null>(null);

  // The chosen profile is remembered across Review tabs (a fresh tab used to
  // start at "none", and an approved course silently shipped unstyled).
  const LAST_STYLE_KEY = 'creator:lastStyle';
  const rememberStyle = useCallback((file: string) => {
    setStyleFile(file);
    try {
      void browser.storage.local.set({ [LAST_STYLE_KEY]: file });
    } catch {
      /* storage unavailable — selection still applies to this tab */
    }
  }, []);
  const refreshStyles = useCallback(async (handle: FileSystemDirectoryHandle) => {
    const list = await listStyles(handle);
    setStyles(list);
    let remembered = '';
    try {
      const got = await browser.storage.local.get(LAST_STYLE_KEY);
      remembered = typeof got[LAST_STYLE_KEY] === 'string' ? (got[LAST_STYLE_KEY] as string) : '';
    } catch {
      remembered = '';
    }
    setStyleFile((cur) => {
      if (cur && list.some((s) => s.fileName === cur)) return cur;
      if (remembered && list.some((s) => s.fileName === remembered)) return remembered;
      return list.length === 1 ? list[0]!.fileName : '';
    });
  }, []);

  // Stored profiles live in the Creator folder — reload whenever it is usable.
  useEffect(() => {
    if (folder && folderReady) void refreshStyles(folder);
    else setStyles([]);
  }, [folder, folderReady, refreshStyles]);

  // Restore the read-only folders (the asset folder is shared with the Creator page).
  useEffect(() => {
    void (async () => {
      const h = await loadDirHandle(ASSET_FOLDER_KEY);
      if (h) {
        setAssetFolder(h);
        if (await verifyReadPermission(h, false)) setAssetListing(await listFolderFiles(h));
        else setAssetNeedsGrant(true);
      }
      const src = await loadDirHandle(STYLE_SOURCE_FOLDER_KEY);
      if (src) setStyleSource(src);
    })();
  }, []);

  const connectAssetFolder = useCallback(async () => {
    setStyleError(null);
    try {
      if (assetFolder && assetNeedsGrant && (await verifyReadPermission(assetFolder, true))) {
        setAssetNeedsGrant(false);
        setAssetListing(await listFolderFiles(assetFolder));
        return;
      }
      const h = await pickDirectory('read');
      await saveDirHandle(h, ASSET_FOLDER_KEY);
      setAssetFolder(h);
      setAssetNeedsGrant(false);
      setAssetListing(await listFolderFiles(h));
    } catch (e) {
      if (!isAbort(e)) setStyleError(errText(e));
    }
  }, [assetFolder, assetNeedsGrant]);

  const connectStyleSource = useCallback(
    async (repick = false) => {
      setStyleError(null);
      setHarvestReport(null);
      setSourceCourses(null);
      let h: FileSystemDirectoryHandle | null = null;
      try {
        h = repick ? null : styleSource;
        if (!h || !(await verifyReadPermission(h, true))) {
          h = await pickDirectory('read');
          await saveDirHandle(h, STYLE_SOURCE_FOLDER_KEY);
          setStyleSource(h);
        }
        const { origin, state, courses } = await listArchiveCourses(h);
        if (origin !== 'rise-export') {
          throw new Error(
            `"${h.name}" is a "${origin ?? 'unknown'}" archive — a style is harvested from a rise-export archive of finished courses. Pick another folder.`,
          );
        }
        if (state !== 'ready') {
          throw new Error(
            `"${h.name}" is a rise-export archive in state "${state ?? 'unknown'}" — its export did not finish (no media). Pick a complete archive (state "ready", with an assets/ folder).`,
          );
        }
        setSourceCourses(courses);
        setSourceSelectedRaw([]);
      } catch (e) {
        if (isAbort(e)) return;
        setStyleError(errText(e));
        // A rejected folder is forgotten, so the next click opens the picker.
        if (h) {
          setStyleSource(null);
          await clearDirHandle(STYLE_SOURCE_FOLDER_KEY);
        }
      }
    },
    [styleSource],
  );

  const harvest = useCallback(async () => {
    if (!folder || !styleSource || sourceSelected.length === 0 || harvesting) return;
    setHarvesting(true);
    setStyleError(null);
    setHarvestReport(null);
    try {
      if (!(await verifyPermission(folder, true))) {
        throw new Error('No write permission for the Creator folder.');
      }
      const manifest = browser.runtime.getManifest();
      const name =
        harvestName.trim() ||
        sourceCourses?.find((c) => c.id === sourceSelected[0])?.title ||
        'Style';
      const outcome = await harvestFromArchive({
        source: styleSource,
        creator: folder,
        courseIds: sourceSelected,
        name,
        toolVersion: manifest.version_name ?? manifest.version,
      });
      setHarvestReport([
        `Saved ${outcome.savedAs} · ${outcome.copied} asset file(s) copied into the Creator folder`,
        ...outcome.report,
      ]);
      await refreshStyles(folder);
      rememberStyle(outcome.savedAs.replace(/^_creator\/styles\//, ''));
    } catch (e) {
      setStyleError(errText(e));
    } finally {
      setHarvesting(false);
    }
  }, [folder, styleSource, sourceSelected, harvesting, harvestName, sourceCourses, refreshStyles, rememberStyle]);

  const selectedStyle = useMemo(
    () => styles.find((s) => s.fileName === styleFile)?.profile ?? null,
    [styles, styleFile],
  );

  const fileCheck = useMemo(() => {
    if (!blueprint) return null;
    const names = blueprintFileNames(blueprint);
    if (names.length === 0) return { names, missing: [] as string[] };
    const missing = assetListing ? names.filter((n) => !assetListing.files.has(n)) : names;
    return { names, missing };
  }, [blueprint, assetListing]);

  return {
    styles,
    styleFile,
    setStyleFile: rememberStyle,
    selectedStyle,
    styleSource,
    sourceCourses,
    sourceSelected,
    setSourceSelected: (fn) => setSourceSelectedRaw(fn),
    harvestName,
    setHarvestName,
    harvesting,
    harvestReport,
    styleError,
    assetFolder,
    assetNeedsGrant,
    assetListing,
    fileCheck,
    connectAssetFolder,
    connectStyleSource,
    harvest,
  };
}

export function StyleCard({ s, folderReady }: { s: StyleState; folderReady: boolean }) {
  const { selectedStyle, fileCheck } = s;
  return (
    <section className="card">
      <h2>Style</h2>
      <p className="hint">
        A style profile is harvested from a rise-export archive of the designer's finished courses
        (theme, fonts, Mighty type styles, block settings, band rhythm, lesson opener/closer,
        banners, video card, shared pictures) and applied on top of this blueprint. Without one the
        course ships in Rise's default look.
      </p>
      {!folderReady ? (
        <p className="hint">Connect the Creator folder below first — profiles are stored in it.</p>
      ) : (
        <>
          <div className="row">
            <label className="field-label" htmlFor="style-select">
              Apply style:
            </label>
            <select id="style-select" value={s.styleFile} onChange={(e) => s.setStyleFile(e.target.value)}>
              <option value="">— none (Rise default look) —</option>
              {s.styles.map((st) => (
                <option key={st.fileName} value={st.fileName}>
                  {st.profile.name} · harvested {st.profile.harvestedAt.slice(0, 10)} from{' '}
                  {st.profile.sourceTitles.filter(Boolean).join(' + ') || st.profile.sourceCourseIds.join(', ')}
                </option>
              ))}
            </select>
          </div>
          {!selectedStyle && s.styles.length > 0 && (
            <p className="error">
              ⚠ No style selected — this course would ship in Rise's default look. Pick one above.
            </p>
          )}
          {selectedStyle && (
            <p className="hint">
              {selectedStyle.typography.styles.length} type styles ·{' '}
              {Object.keys(selectedStyle.blocks).length} block types ·{' '}
              {selectedStyle.motifs.opener ? 'opener ✓' : 'opener —'} ·{' '}
              {selectedStyle.motifs.closer ? 'closer ✓' : 'closer —'} ·{' '}
              {selectedStyle.motifs.banners.length} banner(s) ·{' '}
              {selectedStyle.motifs.video ? 'video card ✓' : 'video card —'} ·{' '}
              {selectedStyle.assets.length} shared asset(s)
            </p>
          )}
          <details>
            <summary className="hint">Harvest a new style from a rise-export archive…</summary>
            <div className="row">
              <button onClick={() => void s.connectStyleSource()}>
                {s.styleSource
                  ? `Style source: ${s.styleSource.name} (list courses)`
                  : 'Pick the style source archive…'}
              </button>
              {s.styleSource && (
                <button onClick={() => void s.connectStyleSource(true)}>Change style source…</button>
              )}
            </div>
            {s.sourceCourses && (
              <>
                <p className="hint">
                  Tick the finished courses to harvest from. The FIRST ticked course supplies the
                  theme, fonts and cover; all of them feed the block-settings modes and motifs.
                </p>
                <ul className="issue-list">
                  {s.sourceCourses.map((c) => (
                    <li key={c.id}>
                      <label className="ack">
                        <input
                          type="checkbox"
                          checked={s.sourceSelected.includes(c.id)}
                          onChange={(e) =>
                            s.setSourceSelected((cur) =>
                              e.target.checked ? [...cur, c.id] : cur.filter((x) => x !== c.id),
                            )
                          }
                        />{' '}
                        {s.sourceSelected.includes(c.id) && <b>#{s.sourceSelected.indexOf(c.id) + 1} </b>}
                        {c.title} <code>{c.id}</code>
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="row">
                  <input
                    type="text"
                    placeholder="Style name (e.g. VAS Europe)"
                    value={s.harvestName}
                    onChange={(e) => s.setHarvestName(e.target.value)}
                  />
                  <button
                    className="approve"
                    disabled={s.sourceSelected.length === 0 || s.harvesting}
                    onClick={() => void s.harvest()}
                  >
                    {s.harvesting ? 'Harvesting…' : 'Harvest style → save to Creator folder'}
                  </button>
                </div>
              </>
            )}
            {s.harvestReport && (
              <ul className="notes">
                {s.harvestReport.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
          </details>
        </>
      )}
      <div className="row">
        <button onClick={() => void s.connectAssetFolder()}>
          {s.assetFolder
            ? s.assetNeedsGrant
              ? `Restore access: ${s.assetFolder.name}`
              : `Asset folder: ${s.assetFolder.name} (change…)`
            : 'Connect asset folder (pictures / PDFs the blueprint names)…'}
        </button>
        {s.assetListing && <span className="hint">{s.assetListing.files.size} media file(s) available</span>}
      </div>
      {fileCheck && fileCheck.names.length > 0 && (
        <p className={fileCheck.missing.length ? 'error' : 'hint'}>
          Blueprint names {fileCheck.names.length} file(s)
          {fileCheck.missing.length > 0
            ? ` — ${fileCheck.missing.length} not found in the asset folder (left out, noted in the plan): ${fileCheck.missing.join(', ')}`
            : ' — all found in the asset folder.'}
        </p>
      )}
      {fileCheck && fileCheck.names.length > 0 && !selectedStyle && (
        <p className="hint">
          Pictures are placed only when a style profile is applied (they ride on its image + text
          donor block).
        </p>
      )}
      {s.styleError && <p className="error">⚠ {s.styleError}</p>}
    </section>
  );
}
