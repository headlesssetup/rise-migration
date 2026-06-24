import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { md5Base64, md5Bytes, md5Hex } from './md5';

// RFC 1321 / standard test vectors.
const VECTORS: Array<[string, string]> = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['a', '0cc175b9c0f1b6a831c399e269772661'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
  ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
];

describe('md5Hex', () => {
  for (const [input, hex] of VECTORS) {
    it(`hashes ${JSON.stringify(input.slice(0, 20))}`, () => {
      expect(md5Hex(input)).toBe(hex);
    });
  }

  it('handles a multi-block (>64 byte) input', () => {
    // 80 chars of 'a' — crosses the 64-byte block boundary + a padding block.
    const s = 'a'.repeat(80);
    expect(md5Hex(s)).toBe(createHash('md5').update(s).digest('hex'));
  });

  it('hashes raw bytes the same as the equivalent string', () => {
    const bytes = new TextEncoder().encode('abc');
    expect(md5Hex(bytes)).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
});

describe('md5 vs node:crypto (fuzz)', () => {
  it('matches node crypto on assorted lengths', () => {
    for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 200, 1000]) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 31 + 7) & 0xff;
      const ref = createHash('md5').update(bytes).digest('hex');
      expect(md5Hex(bytes)).toBe(ref);
    }
  });
});

describe('md5Base64', () => {
  it('is the base64 of the digest bytes', () => {
    expect(md5Base64('')).toBe('1B2M2Y8AsgTpgAmY7PhCfg==');
    // base64 and hex describe the same 16 bytes.
    const bytes = md5Bytes('hello world');
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    expect(md5Base64('hello world')).toBe(btoa(bin));
    expect(md5Hex('hello world')).toBe([...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''));
  });
});
