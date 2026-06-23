import { describe, it, expect } from 'vitest';
import { s3PutHeaders } from './import-shared';

const SIGNED_FONT_URL =
  'https://360-prod-eu-central-1-213152736482.s3.eu-central-1.amazonaws.com/rise/fonts/xvI6Ny9Vw3jxu9sa.woff' +
  '?Content-Type=font%2Fwoff&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260623T193258Z' +
  '&X-Amz-Expires=1800&X-Amz-Signature=deadbeef&X-Amz-SignedHeaders=host%3Bx-amz-acl&x-amz-acl=public-read';

describe('s3PutHeaders', () => {
  it('adds x-amz-acl when the presigned url signs it (font uploads)', () => {
    expect(s3PutHeaders(SIGNED_FONT_URL, 'font/woff')).toEqual({
      'Content-Type': 'font/woff',
      'x-amz-acl': 'public-read',
    });
  });

  it('does NOT add x-amz-acl when the url does not sign it (image uploads untouched)', () => {
    const url =
      'https://bucket.s3.amazonaws.com/rise/courses/x/img.png' +
      '?X-Amz-Signature=abc&X-Amz-SignedHeaders=host';
    expect(s3PutHeaders(url, 'image/png')).toEqual({ 'Content-Type': 'image/png' });
  });

  it('uses the signed acl value verbatim (not a hardcoded public-read)', () => {
    const url = 'https://b.s3.amazonaws.com/k?X-Amz-SignedHeaders=host%3Bx-amz-acl&x-amz-acl=private';
    expect(s3PutHeaders(url, 'font/woff')['x-amz-acl']).toBe('private');
  });

  it('omits Content-Type when none is given, still honoring the acl', () => {
    expect(s3PutHeaders(SIGNED_FONT_URL)).toEqual({ 'x-amz-acl': 'public-read' });
  });

  it('falls back to Content-Type only for an unparseable url', () => {
    expect(s3PutHeaders('not a url', 'font/woff')).toEqual({ 'Content-Type': 'font/woff' });
  });
})
