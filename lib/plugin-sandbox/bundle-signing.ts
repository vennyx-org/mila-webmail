// Client-side Ed25519 verification for plugin bundles.
//
// On boot the loader fetches the host's public key from
// `/api/plugin-signing-pubkey`. Each `/api/admin/plugins/[id]/bundle` response
// includes the signature as the `X-Bundle-Signature` header. Before evaluating
// a bundle the loader verifies the signature; mismatch refuses the load.
//
// User-installed plugins (uploaded via the file picker, no server hop) have
// no signature — verification is skipped for those, since the user is
// installing their own code. Verification kicks in for server-managed
// bundles only (the `managed: true` flag on `InstalledPlugin`).

let cachedPubKey: CryptoKey | null = null;
let pubKeyPromise: Promise<CryptoKey | null> | null = null;

async function importEd25519PublicKey(raw: Uint8Array): Promise<CryptoKey | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  try {
    // Browser Web Crypto supports Ed25519 via `name: 'Ed25519'` (no hash).
    return await crypto.subtle.importKey('raw', raw.buffer.slice(0) as ArrayBuffer, { name: 'Ed25519' }, false, ['verify']);
  } catch (err) {
    console.warn('[plugin-signing] Web Crypto Ed25519 import failed', err);
    return null;
  }
}

async function fetchPublicKey(): Promise<CryptoKey | null> {
  try {
    const res = await fetch('/api/plugin-signing-pubkey', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = await res.json() as { algorithm?: string; publicKey?: string };
    if (data.algorithm !== 'ed25519' || typeof data.publicKey !== 'string') return null;
    const raw = base64ToBytes(data.publicKey);
    if (raw.length !== 32) return null;
    return importEd25519PublicKey(raw);
  } catch (err) {
    console.warn('[plugin-signing] could not fetch public key', err);
    return null;
  }
}

export async function getPluginSigningKey(): Promise<CryptoKey | null> {
  if (cachedPubKey) return cachedPubKey;
  if (!pubKeyPromise) {
    pubKeyPromise = fetchPublicKey().then((k) => { cachedPubKey = k; return k; });
  }
  return pubKeyPromise;
}

/** Force a refresh on next access (e.g. after key rotation). */
export function invalidatePluginSigningKeyCache(): void {
  cachedPubKey = null;
  pubKeyPromise = null;
}

/**
 * Verify a base64 Ed25519 signature against the bundle bytes. Returns false
 * on any failure (missing key, invalid encoding, signature mismatch). Never
 * throws.
 */
export async function verifySignature(code: string, signatureB64: string): Promise<boolean> {
  if (!signatureB64) return false;
  const key = await getPluginSigningKey();
  if (!key) return false;
  let signature: Uint8Array;
  try {
    signature = base64ToBytes(signatureB64);
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  const data = new TextEncoder().encode(code);
  try {
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      signature.buffer.slice(0) as ArrayBuffer,
      data.buffer.slice(0) as ArrayBuffer,
    );
  } catch {
    return false;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
