/** Markers that introduce a JPEG frame header, whose payload carries the size.
 * The gaps are deliberate: C4, C8 and CC are tables and restarts, not frames. */
function isJpegFrameMarker(code: number): boolean {
  if (code < 0xc0 || code > 0xcf) return false
  return code !== 0xc4 && code !== 0xc8 && code !== 0xcc
}

/** Read intrinsic dimensions from a raster image header, when available. */
export function imageDimensions(head: Buffer): { width: number; height: number } | undefined {
  // PNG: IHDR is always the first chunk, so the size sits at a fixed offset.
  if (head.length >= 24 && head.subarray(12, 16).toString('latin1') === 'IHDR') {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
  }
  // GIF: logical screen descriptor, immediately after the signature.
  if (head.length >= 10 && head.subarray(0, 3).toString('latin1') === 'GIF') {
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) }
  }
  // BMP: DIB header. Height is signed — negative means a top-down bitmap.
  if (head.length >= 26 && head[0] === 0x42 && head[1] === 0x4d) {
    return { width: head.readInt32LE(18), height: Math.abs(head.readInt32LE(22)) }
  }
  if (head.length >= 30 && head.subarray(0, 4).toString('latin1') === 'RIFF') {
    const chunk = head.subarray(12, 16).toString('latin1')
    if (chunk === 'VP8 ') {
      return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff }
    }
    if (chunk === 'VP8L') {
      const bits = head.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8X') {
      return {
        width: (head.readUIntLE(24, 3) & 0xffffff) + 1,
        height: (head.readUIntLE(27, 3) & 0xffffff) + 1,
      }
    }
    return undefined
  }
  // JPEG: walk the segment chain to the frame header. Unlike the others the
  // offset is not fixed — EXIF, ICC profiles and comments all come first.
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
    let at = 2
    while (at + 9 < head.length) {
      if (head[at] !== 0xff) {
        at++
        continue
      }
      const code = head[at + 1]!
      if (isJpegFrameMarker(code)) {
        return { width: head.readUInt16BE(at + 7), height: head.readUInt16BE(at + 5) }
      }
      // Standalone markers carry no length field to skip over.
      if (code === 0xd8 || code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
        at += 2
        continue
      }
      if (code === 0xda) return undefined // scan data: no header left to find
      at += 2 + head.readUInt16BE(at + 2)
    }
  }
  return undefined
}
