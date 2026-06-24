// MD5 (RFC 1321) over raw bytes — hex + base64 digests.
//
// Why hand-rolled: the Review-360 upload handshake needs MD5 of the package zip
// in TWO encodings and `crypto.subtle` does not implement MD5:
//   - `yurl:get` query wants base64 MD5 (`md5=9EGd4VrHnsIvYZ363J4Ojw==`),
//   - `items:update` wants hex MD5 (`md5_checksum:"f4419de15ac79ec22f619dfadc9e0e8f"`),
//   - and the presigned S3 PUT must carry the same value as `Content-MD5` (base64).
// All three are the same digest of the same bytes (capture-confirmed).
//
// Pure + dependency-free so it runs identically in the service worker and vitest.

function toBytes(input: Uint8Array | string): Uint8Array {
  return typeof input === 'string' ? new TextEncoder().encode(input) : input;
}

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(2^32 * abs(sin(i+1))). Precomputed as a constant table so the
// module needs no Math.sin at load (and stays deterministic across engines).
const K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

function rotl(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

/** MD5 digest of bytes → 16-byte Uint8Array. */
export function md5Bytes(input: Uint8Array | string): Uint8Array {
  const msg = toBytes(input);
  const origLenBits = msg.length * 8;

  // Pad: 0x80, then zeros, to 56 mod 64, then 64-bit little-endian length.
  const withOne = msg.length + 1;
  const padded = new Uint8Array((Math.ceil((withOne + 8) / 64)) * 64);
  padded.set(msg);
  padded[msg.length] = 0x80;
  // 64-bit length, little-endian (low 32 bits are enough for our sizes but write
  // the full 64 for correctness on large inputs).
  const lenLo = origLenBits >>> 0;
  const lenHi = Math.floor(origLenBits / 0x100000000) >>> 0;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, lenLo, true);
  dv.setUint32(padded.length - 4, lenHi, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Int32Array(16);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);

    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) {
        f = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        f = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        f = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + f + K[i]! + M[g]!) | 0;
      B = (B + rotl(sum >>> 0, S[i]!)) | 0;
      A = tmp;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0 >>> 0, true);
  ov.setUint32(4, b0 >>> 0, true);
  ov.setUint32(8, c0 >>> 0, true);
  ov.setUint32(12, d0 >>> 0, true);
  return out;
}

/** Lowercase hex MD5 (for `items:update.package.md5_checksum`). */
export function md5Hex(input: Uint8Array | string): string {
  return [...md5Bytes(input)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Base64 MD5 (for the `yurl:get` `md5=` param and the S3 `Content-MD5` header). */
export function md5Base64(input: Uint8Array | string): string {
  const bytes = md5Bytes(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
