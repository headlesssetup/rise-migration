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
  /** Write the content-level census deliverables (after GET_COURSE fetch). */
  writeCensus(json: string, csv: string): Promise<void>;
  /** Write the per-variant field-profile catalog (the block knowledge base). */
  writeCatalog(json: string, csv: string): Promise<void>;
  /** Write the Tier-2 novelty report (new variants + new fields vs catalog). */
  writeNovelty(json: string, csv: string): Promise<void>;
}
