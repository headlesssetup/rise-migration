// Storage interface — FileSystemStorage now, DbStorage later (build plan §2).
// The pipeline talks only to this interface so the backend can be swapped
// without touching orchestration logic.

export interface Storage {
  /** Write a course's raw GET_COURSE body verbatim (immutable source of truth). */
  writeCourse(courseId: string, raw: string): Promise<void>;
  /** Read back a previously-saved raw course body, or null if absent. */
  readCourse(courseId: string): Promise<string | null>;
  /** Has this course already been saved? (enables resume / skip). */
  hasCourse(courseId: string): Promise<boolean>;
  /** Course ids already present in the store. */
  listSaved(): Promise<string[]>;
  /** Write the run manifest (index/counts/version/validation summary). */
  writeManifest(manifest: unknown): Promise<void>;
  /** Write the list-level inventory (catalog from the search listing). */
  writeInventory(json: string, csv: string): Promise<void>;
  /** Read the list-level inventory JSON (for folder counts), or null. */
  readInventory(): Promise<string | null>;
  /** Write the content-level census deliverables (after GET_COURSE fetch). */
  writeCensus(json: string, csv: string): Promise<void>;
  /** Write the per-variant field-profile catalog (the block knowledge base). */
  writeCatalog(json: string, csv: string): Promise<void>;
  /** Write the Tier-2 novelty report (new variants + new fields vs catalog). */
  writeNovelty(json: string, csv: string): Promise<void>;
  /** Write the raw question-banks list response. */
  writeBankIndex(raw: string): Promise<void>;
  /** Write one question bank's raw body verbatim. */
  writeQuestionBank(bankId: string, raw: string): Promise<void>;
  /** Has this question bank already been saved? */
  hasQuestionBank(bankId: string): Promise<boolean>;
  /** Read back a saved question bank, or null. */
  readQuestionBank(bankId: string): Promise<string | null>;
  /** Bank ids already saved. */
  listSavedBanks(): Promise<string[]>;
  /** Read the raw question-banks index (for bank-folder + bank parsing), or null. */
  readBankIndex(): Promise<string | null>;
  /** Write the question-bank catalog (per-question-type field profiles). */
  writeBankCatalog(json: string, csv: string): Promise<void>;
  /** Write the raw folders list response. */
  writeFolders(raw: string): Promise<void>;
  /** Read the raw folders list response, or null. */
  readFolders(): Promise<string | null>;
  /** Write the combined folder inventory (course + bank, with name-paths). */
  writeFolderInventory(json: string, csv: string): Promise<void>;

  // --- Phase 2: assets (content-addressed binaries + per-owner manifests) ---
  /** Write a content-addressed asset blob: `assets/<name>` (name=`<sha256>.<ext>`). */
  writeAsset(name: string, bytes: Uint8Array): Promise<void>;
  /** Is this content-addressed asset already stored? (cross-owner dedup). */
  hasAsset(name: string): Promise<boolean>;
  /** Write a course/bank's asset manifest → `<scope>/<id>.assets.json`. */
  writeAssetManifest(
    scope: 'courses' | 'question-banks',
    id: string,
    json: string,
  ): Promise<void>;
  /** Has this owner's asset manifest already been written? (resume). */
  hasAssetManifest(
    scope: 'courses' | 'question-banks',
    id: string,
  ): Promise<boolean>;
  /** Read a prior asset manifest (for resume / retry), or null if absent. */
  readAssetManifest(
    scope: 'courses' | 'question-banks',
    id: string,
  ): Promise<string | null>;
  /** Write the run-wide assets summary (totals + un-downloaded-key assertion). */
  writeAssetsSummary(json: string): Promise<void>;
}
