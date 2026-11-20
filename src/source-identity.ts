import type {SourceIdentity} from "./model";

const FINGERPRINT_CHUNK_SIZE = 64 * 1024;

/**
 * Create a cheap replacement fingerprint without hashing the entire potentially
 * large file. This is not a full-file content hash: the size, first 64 KiB, and
 * last 64 KiB are hashed together.
 */
export async function createSourceIdentity(
  path: string,
  data: ArrayBuffer
): Promise<SourceIdentity> {
  const bytes = new Uint8Array(data);
  const chunkLength = Math.min(FINGERPRINT_CHUNK_SIZE, bytes.length);
  const first = bytes.subarray(0, chunkLength);
  const last = bytes.subarray(Math.max(0, bytes.length - chunkLength));
  const fingerprintInput = new Uint8Array(8 + first.length + last.length);
  new DataView(fingerprintInput.buffer).setBigUint64(0, BigInt(bytes.length), false);
  fingerprintInput.set(first, 8);
  fingerprintInput.set(last, 8 + first.length);
  const digest = await crypto.subtle.digest("SHA-256", fingerprintInput);
  return {
    path,
    fingerprint: `sha256-partial:${toHex(new Uint8Array(digest))}`,
    size: bytes.length
  };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
