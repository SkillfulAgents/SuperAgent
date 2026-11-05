// Checks that the update feed answers a multi-range request for a released file
// the way electron-updater's differential download needs: 206 with a
// multipart/byteranges body whose parts hold the file's own bytes. Any other
// answer and the updater silently downloads the whole file instead, which every
// macOS update did until gamut-releases#2 (1.2 GB with the agent image bundled).
//
// Usage: node scripts/check-feed-ranges.mjs <file's feed URL> <the same file, local>
import { openSync, readSync, fstatSync, closeSync } from 'node:fs'

const [url, localPath] = process.argv.slice(2)
if (!url || !localPath) {
  console.error('Usage: node scripts/check-feed-ranges.mjs <file url> <local file>')
  process.exit(2)
}

let fd
try {
  fd = openSync(localPath, 'r')
} catch (error) {
  console.error(`::error::${localPath}: not in this release (${error.code ?? error.message}), so ${url} can't be checked.`)
  process.exit(1)
}
const size = fstatSync(fd).size
const slice = (start, end) => {
  const buf = Buffer.alloc(end - start + 1)
  readSync(fd, buf, 0, buf.length, start)
  return buf
}

// Three ranges spread over the file, as a differential download's would be.
const mid = Math.floor(size / 2)
const ranges = [[0, 15], [mid, mid + 15], [size - 16, size - 1]]

const WHOLE_FILE = 'Auto-updates fall back to downloading the whole file'
const BAD_PARTS = 'Differential downloads fail their checksum, and auto-updates fall back to downloading the whole file'

function fail(message, consequence = BAD_PARTS) {
  console.error(`::error::${url}: ${message}. ${consequence}.`)
  process.exit(1)
}

const res = await fetch(url, { headers: { Range: `bytes=${ranges.map(([a, b]) => `${a}-${b}`).join(',')}` } })
const type = res.headers.get('content-type') ?? ''
const boundary = /^multipart\/byteranges;\s*boundary=(?:"([^"]+)"|([^\s";]+))/i.exec(type)
if (res.status !== 206 || !boundary) {
  // Not the body: a 200 here is the whole file.
  await res.body?.cancel()
  fail(
    `a multi-range request got ${res.status} ${type || '(no content type)'}, not 206 multipart/byteranges`,
    res.ok ? WHOLE_FILE : 'The feed is not serving this released file at all',
  )
}

const body = Buffer.from(await res.arrayBuffer())
const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`)
let offset = body.indexOf(delimiter)
for (const [start, end] of ranges) {
  if (offset === -1) fail(`the body has fewer parts than the ${ranges.length} ranges asked for`)
  const headersEnd = body.indexOf('\r\n\r\n', offset)
  if (headersEnd === -1) fail('a part has no end to its headers')
  const headers = body.subarray(offset + delimiter.length, headersEnd).toString('latin1')
  const contentRange = /content-range:\s*bytes (\d+)-(\d+)\/(\d+)/i.exec(headers)
  if (!contentRange || Number(contentRange[1]) !== start || Number(contentRange[2]) !== end || Number(contentRange[3]) !== size) {
    fail(`a part says ${contentRange?.[0] ?? 'no Content-Range'}, expected bytes ${start}-${end}/${size}`)
  }
  const data = body.subarray(headersEnd + 4, headersEnd + 4 + (end - start + 1))
  if (!data.equals(slice(start, end))) fail(`the bytes ${start}-${end} differ from the released file's`)
  offset = body.indexOf(delimiter, headersEnd + 4 + data.length)
}
closeSync(fd)
console.log(`${url}: 206 multipart/byteranges, ${ranges.length} parts match the released file`)
