import { describe, expect, it } from 'vitest';
import {
  buildItemsCreate,
  buildItemsUpdate,
  buildItemsUpload,
  buildYurlGetArg,
  deriveKeyFromUrl,
  isItemReady,
  parseContentPrefix,
  parseYurlAck,
} from './review-protocol';

const USER = 'auth0|671e98d0-b37b-0131-2ee8-22000b2f96a1';
const CREATED = '2026-06-24T16:50:26.666Z';

describe('buildItemsCreate', () => {
  it('matches the captured create payload shape', () => {
    expect(buildItemsCreate({ title: 'Untitled2.zip', userId: USER, createdAt: CREATED })).toEqual({
      title: 'Untitled2.zip',
      projectId: 'Untitled2.zip',
      product: 'storyline',
      platform: { os: 'windows', type: 'web' },
      userId: USER,
      folderId: 'private',
      versions: [
        {
          createdAt: CREATED,
          package: {},
          thumbnail: {},
          progress: 0,
          state: 'uploading',
          userId: USER,
        },
      ],
    });
  });
});

describe('buildYurlGetArg', () => {
  it('produces the captured query string (encoded / and md5 ==)', () => {
    const arg = buildYurlGetArg({ fileName: 'Untitled2.zip', md5Base64: '9EGd4VrHnsIvYZ363J4Ojw==' });
    expect(arg).toBe(
      'acl=public-read&keyPrefix=review%2Fuploads&fileName=Untitled2.zip&md5=9EGd4VrHnsIvYZ363J4Ojw%3D%3D',
    );
  });
});

describe('deriveKeyFromUrl / parseYurlAck', () => {
  const presigned =
    'https://360-prod-eu-central-1-213152736482.s3.eu-central-1.amazonaws.com/review/uploads/eIb7nVxu63wK4j7u/untitled-2.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc';

  it('derives the S3 key from a presigned url', () => {
    expect(deriveKeyFromUrl(presigned)).toBe('review/uploads/eIb7nVxu63wK4j7u/untitled-2.zip');
  });

  it('parses a bare-string ack', () => {
    expect(parseYurlAck(presigned)).toEqual({
      url: presigned,
      key: 'review/uploads/eIb7nVxu63wK4j7u/untitled-2.zip',
    });
  });

  it('parses an object ack and prefers an explicit key', () => {
    expect(parseYurlAck({ uploadUrl: presigned, key: 'review/uploads/x/y.zip' })).toEqual({
      url: presigned,
      key: 'review/uploads/x/y.zip',
    });
  });

  it('throws when no url is present', () => {
    expect(() => parseYurlAck({ nope: 1 })).toThrow(/no upload url/);
  });
});

describe('buildItemsUpdate / buildItemsUpload', () => {
  it('matches the captured update payload', () => {
    expect(
      buildItemsUpdate({
        id: '29c5263b-6f84-4187-a0c9-c98dbd10b610',
        key: 'review/uploads/eIb7nVxu63wK4j7u/untitled-2.zip',
        md5Hex: 'f4419de15ac79ec22f619dfadc9e0e8f',
        userId: USER,
        createdAt: CREATED,
      }),
    ).toEqual({
      versions: [
        {
          state: 'uploading',
          userId: USER,
          package: {
            key: 'review/uploads/eIb7nVxu63wK4j7u/untitled-2.zip',
            md5_checksum: 'f4419de15ac79ec22f619dfadc9e0e8f',
          },
          progress: 0,
          createdAt: CREATED,
          thumbnail: {},
        },
      ],
      id: '29c5263b-6f84-4187-a0c9-c98dbd10b610',
      sendBroadcastMessages: false,
    });
  });

  it('defaults items:upload type to storyline', () => {
    expect(buildItemsUpload({ id: 'x' })).toEqual({ id: 'x', type: 'storyline' });
  });
});

describe('parseContentPrefix / isItemReady', () => {
  it('reads contentPrefix directly', () => {
    expect(parseContentPrefix({ contentPrefix: 'review/items/8xpbdD4sL5UzcQgp' })).toBe(
      'review/items/8xpbdD4sL5UzcQgp',
    );
  });

  it('unwraps an item-envelope ack', () => {
    expect(parseContentPrefix({ item: { contentPrefix: 'review/items/abc' } })).toBe('review/items/abc');
  });

  it('unwraps the items:get {success,value} ack envelope (capture-confirmed)', () => {
    expect(
      parseContentPrefix({ success: true, value: { contentPrefix: 'review/items/Q8FESjfUTG1pKZ9O' } }),
    ).toBe('review/items/Q8FESjfUTG1pKZ9O');
    expect(isItemReady({ success: true, value: { contentPrefix: 'review/items/Q8FESjfUTG1pKZ9O' } })).toBe(true);
    expect(isItemReady({ success: true, value: { versions: [{ state: 'uploading' }] } })).toBe(false);
  });

  it('derives the prefix from a version package key', () => {
    expect(
      parseContentPrefix({
        versions: [{ package: { key: 'review/items/QQ9/story_content/thumbnail.jpg' } }],
      }),
    ).toBe('review/items/QQ9');
  });

  it('returns null when not yet published', () => {
    expect(parseContentPrefix({ versions: [{ state: 'uploading', package: {} }] })).toBeNull();
    expect(parseContentPrefix(null)).toBeNull();
  });

  it('detects readiness from the latest version state', () => {
    expect(isItemReady({ versions: [{ state: 'uploading' }, { state: 'ready' }] })).toBe(true);
    expect(isItemReady({ versions: [{ state: 'processing' }] })).toBe(false);
  });
});
