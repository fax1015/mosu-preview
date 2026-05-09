/**
 * Encode binary for extension messaging. Chrome MV3 callbacks / structured clone can drop
 * ArrayBuffer fields from onMessage replies; base64 survives JSON-ish serialization paths.
 */

const encoderChunkSize = 16 * 1024;

export const uint8ToBase64 = (bytes) => {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return '';
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += encoderChunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + encoderChunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
};

export const base64ToUint8Array = (b64) => {
  if (!b64 || typeof b64 !== 'string') {
    return new Uint8Array(0);
  }
  const binary = atob(b64);
  const len = binary.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
};
