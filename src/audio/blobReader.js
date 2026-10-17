// A view of a Blob that loads one chunk at a time, so indexing a marathon's
// audio does not hold a second copy of the whole file in memory.
const createChunkReader = (blob, chunkBytes) => {
  let start = 0;
  let bytes = new Uint8Array(0);
  return {
    size: blob.size,
    has: (offset, length) => offset >= start && offset + length <= start + bytes.length,
    byte: (offset) => bytes[offset - start],
    async load(offset, length) {
      const end = Math.min(blob.size, offset + Math.max(chunkBytes, length));
      bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      start = offset;
    },
  };
};

export { createChunkReader };
