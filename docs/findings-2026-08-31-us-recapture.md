# Findings — 2026-08-31 US protocol recapture

Source: `_capture3108/capture-editing-20260831-import-test.mitm`.

The raw capture contains authentication material, account identity data, and
customer content. It is operator-local input and must not be committed. This
document records only redacted protocol findings.

## Verdict

The core migration transport has not been replaced. Course creation, ducks
envelopes, lesson/block writes, locks, image upload, web-export job
acknowledgement, and `GET_COURSE` read-back all retained their known contracts.

The capture did prove three areas of drift:

1. Manage Blocks performs real multi-block move/delete operations using the
   existing `MOVE_BLOCKS` and `DELETE_BLOCKS` envelopes.
2. The runtime bundle pins sent to `build/{courseId}/raw` changed and now
   include `ai_scenario`.
3. Account brands now appear in course documents. Their media namespace and
   account-specific ids are not covered by the migration protocol.

## Multi-block actions

No new authoring endpoint was introduced.

### Move

```json
{
  "type": "rise/lessons/MOVE_BLOCKS",
  "payload": {
    "lessonId": "<lesson>",
    "courseId": "<course>",
    "moves": [
      {
        "blockId": "<block>",
        "previousBlockId": "<block|null>",
        "nextBlockId": "<block|null>"
      }
    ]
  }
}
```

One captured request carried two `moves`. The entries are procedural and
order-sensitive: the second entry's anchors described state produced by the
first entry. A selected set may also produce only one move when one operation
is sufficient to reach the desired order.

Implication: preserve `moves[]` order and confirm final lesson order with
`GET_COURSE`. Do not infer move count from UI selection count.

### Delete

One `DELETE_BLOCKS` request carried three block ids:

```json
{
  "type": "rise/lessons/DELETE_BLOCKS",
  "payload": {
    "blockIds": ["<block-1>", "<block-2>", "<block-3>"],
    "courseId": "<course>",
    "lessonId": "<lesson>"
  }
}
```

The response echoed all ids. This disproves the earlier observation that the
editor always sends a one-element array.

### Duplicate

Multi-select duplicate emitted one single-block `CREATE_BLOCKS` request per
selected block. Two requests overlapped and shared an insertion anchor.
`BULK_UPDATE_BLOCKS` was not used.

The server accepted copied `createdAt`, `updatedAt`, and `globalBlockId` fields
but returned fresh server metadata. The importer should continue stripping
server-owned fields, mint fresh client ids, and issue writes sequentially.

## Web-export version pins

Captured `POST /api/rise-runtime/build/{courseId}/raw` used:

```json
{
  "bundles": {
    "rise_frontend": "138df8347f29d7a2ed31fc506d7f54d1826e4983",
    "ai_scenario": "a5a39ec2268be9757df119279017e713aa697bf1",
    "learn_distribution_frontend": "036472797945bdca27b2c7cfe3a4d0b743a4a977",
    "mondrian": "a0e63065d3a4cbe865042e3ced4865ba54c4f7ad",
    "sandbox": "42753f3391b109fa3788c525c22880445ab48325"
  },
  "lmsDriverVersion": "7.12.0.a.1.6.6"
}
```

The request returned `200 {jobId,riseDistributor}` and the distributor socket
later delivered `package:success`.

## New brand surface — implementation blocked pending capture

Current `GET_COURSE` documents can include:

- `course.theme.brandId`
- `course.theme.appliedBrand`
- `course.theme.colors`
- `course.theme.showLogo`
- `course.media.image`

`appliedBrand` contains materialized colors, typeface ids, and a `logoKey`.
Brand records are available from:

- `GET /manage/api/brands`
- `GET /api/rise-runtime/manage/brands`

Brand logo keys use the previously undocumented account namespace:

```text
rise/brands/<brand-id>/...
```

Applying a brand used `UPDATE_COURSE {id, applyBrandId, theme}`. This capture
did not exercise brand creation, logo upload, or cross-account mapping.
Therefore:

- do not treat `brandId` as portable;
- do not silently ship `rise/brands/...` source keys;
- do not invent a target brand creation request;
- capture brand creation/update and logo upload on disposable US and EU
  accounts before implementing migration.

Until that capture exists, a course carrying these references must be treated
as requiring manual brand handling.

## Other observed document/API additions

- `GET_COURSE.payload.deliveryPolicy`
- `course.awaitingContent`
- `UPDATE_COURSE_DEBOUNCE {id, exportSettings}`
- collaboration notification `rise/courseSnapshots/SNAPSHOT_CREATED`

These did not alter the captured core import sequence. `exportSettings` remains
outside current parity and needs a focused second capture before support.

## Authentication observation

The current US editor's captured ducks requests succeeded with first-party
cookies and no explicit `Authorization` header. This does **not** prove that
extension-relayed calls should stop attaching a bearer; test one controlled
relay request with `omitBearer` before changing auth behavior.

Okta lifecycle refresh still did not rotate `_articulate_rise_`. Some responses
did set Okta session cookies, so the old statement “no Set-Cookie” is too broad;
the important bearer-rotation conclusion remains unchanged.

## Reconfirmed contracts

- `POST /manage/api/content` returns `{id}` and a following `GET_COURSE`
  confirms the shell.
- A regular course shell starts with no lessons.
- `UPDATE_COURSE_FIELD_THROTTLE` remains the title/description write.
- `CREATE_LESSON`, `UPDATE_LESSON`, `CREATE_BLOCKS`,
  `UPDATE_BLOCK_DEBOUNCE`, `PUT_LOCK`, and `DEL_LOCK` retain their shapes.
- Image authoring remains `GET_YURL` → S3 PUT → `CRUSH_IMAGE` → block patch.
- `course.lessons` remains the authoritative lesson order.
- Ducks requests and responses remain `{type,payload}`.
- Web export still completes through the distributor socket.

## Capture limitations and next session

The existing converter truncates responses at 200 KB; all four captured
`GET_COURSE` bodies exceeded that limit and had to be inspected from the raw
MITM. It also omits WebSocket message bodies.

The next focused capture should:

1. create and edit a brand, upload/replace its logo, apply it to a course, and
   remove it;
2. repeat that flow on EU;
3. read back both the brand catalog and course after every action;
4. capture multi-duplicate followed immediately by `GET_COURSE`;
5. move contiguous and non-contiguous selections to start, middle, and end;
6. undo/redo multi-move and multi-delete to exercise
   `BULK_UPDATE_BLOCKS.updates[]`;
7. repeat one multi-action on a localized stack;
8. test one extension-relayed `GET_COURSE` with `omitBearer`.

