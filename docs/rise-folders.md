# Rise Folders — structure & migration

Rise organizes content in folders (with teams/subscriptions). To migrate a whole
account we must **preserve the folder tree** and place each course / question bank
into the right folder on the target. Items already carry a folder id
(`folderId` on courses, `folder_id` on banks); this captures the **folders
themselves** so import can recreate the tree and remap ids.

## Endpoints / sources

- **Course folders:** `GET /manage/api/folders` → the folder tree. Response is an
  **id-keyed object map** (parsed tolerantly as map/array/`{folders}`). Each:
  ```
  { id, name, isRoot, folderType, parentFolderId, renderParentId,
    deletedAt, roleId, ownerPrincipalId, subscriptionId, createdAt }
  ```
  `GET /manage/api/folders/{id}?page=…` lists a folder's content (same params as
  content/search); `GET /manage/api/folders/external` lists external/shared.
- **Bank folders:** returned **inline** in the question-banks list as
  `private_folders` / `shared_folders` — each `{ id, title, parent_id, path,
  deleted, author_id, … }`. (We already save that index, so no extra call.)

## What the tool does (Phase 0 — read-only)

On **List courses**: `GET /manage/api/folders` → save raw `folders.json`. Then it
builds **`folders-inventory.json` / `.csv`** combining course folders + bank
folders (from the saved bank index), resolving each folder's **name-path** via
`parentId` and attaching the **course count per folder** (from `inventory.json`).
After **Fetch question banks**, the inventory is rebuilt so bank folders are
included.

`folders-inventory` columns: `id, name, source(course|bank), type, parentId,
depth, path, deleted, courseCount`.

## Migration plan (Phase 3, not built yet)

1. Read `folders-inventory` (deepest-last by `depth`).
2. For each source folder, create the target folder under its (already-mapped)
   parent; record `oldId → newId`.
3. When creating courses (`POST /manage/api/content {folderId}`) and recreating
   question banks (`POST /manage/api/question-banks {folderId, title}`), pass the
   **mapped** target folder id so content lands in the right place.
4. Skip `deleted` folders (or recreate only if they still hold live content).

> Team / subscription scoping (`ownerPrincipalId`, `subscriptionId`, shared vs
> private) may not map 1:1 across accounts — flag cross-account folder-type
> differences for the operator, like Storyline reachability.
