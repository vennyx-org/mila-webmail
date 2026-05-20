// SHA-256 integrity check for plugin bundles.
//
// The bundle endpoint returns the canonical hash as the ETag. The client
// re-hashes the bytes after fetch and refuses to load on mismatch. This
// closes the gap where a compromised admin route (or transient MITM upstream
// of the CDN/proxy) could swap the bundle silently.

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  // Re-wrap so the buffer is a plain ArrayBuffer (not SharedArrayBuffer) to
  // satisfy lib.dom's BufferSource typing.
  let buf: ArrayBuffer;
  if (typeof input === 'string') {
    buf = new TextEncoder().encode(input).buffer as ArrayBuffer;
  } else {
    const copy = new Uint8Array(input.byteLength);
    copy.set(input);
    buf = copy.buffer;
  }
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    const h = view[i].toString(16);
    out += h.length === 1 ? '0' + h : h;
  }
  return out;
}

/**
 * Compare `actual` and `expected` in constant time. Both must be the same
 * length lower-case hex strings. Returns false on any structural mismatch.
 */
export function constantTimeHexEqual(actual: string, expected: string): boolean {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify `code` against `expectedHash`. Returns the (normalised) hash on
 * match, throws on mismatch. Pass `null`/`undefined` for `expectedHash` to
 * compute-and-return without verification (used for dev-plugin paths).
 */
export async function verifyBundle(code: string, expectedHash: string | null | undefined): Promise<string> {
  const actual = await sha256Hex(code);
  if (!expectedHash) return actual;
  // Server may quote the hash (it's also used as an ETag); strip and compare.
  const normalised = expectedHash.replace(/^"|"$/g, '').trim().toLowerCase();
  if (!constantTimeHexEqual(actual, normalised)) {
    throw new Error(`Bundle integrity mismatch: expected ${normalised}, got ${actual}`);
  }
  return actual;
}
