import * as fs from 'fs';

/** The last `maxBytes` of a file, or null when it cannot be read (a missing file included). */
export async function readFileTail(filePath: string, maxBytes: number): Promise<Buffer | null> {
  try {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      let offset = 0;
      while (offset < buf.length) {
        const { bytesRead } = await handle.read(buf, offset, buf.length - offset, start + offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return buf.subarray(0, offset);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
