#!/usr/bin/env node
/**
 * Fold a live-probe run's recordings into one demo clip.
 *
 * Playwright records one video per page, so the OAuth popup (the login page)
 * lands in its own file. This lays that recording over the main page's
 * recording, picture-in-picture, from the moment the popup opened — using the
 * wall-clock marks the spec writes to timing.json — and encodes an mp4.
 *
 *   node e2e/live/mcp-hot-add/compose-video.mjs <test-output-dir> [out.mp4]
 *
 * Needs ffmpeg on PATH. Prints the output path; exits non-zero if anything is
 * missing so run.mjs can report it without failing the probe.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
if (!dir || !existsSync(dir)) {
  console.error('usage: compose-video.mjs <test-output-dir> [out.mp4]')
  process.exit(2)
}
const out = process.argv[3] ?? path.join(dir, 'mcp-hot-add-demo.mp4')

const videos = readdirSync(dir)
  .filter((f) => f.endsWith('.webm'))
  .map((f) => path.join(dir, f))
  .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
if (videos.length === 0) {
  console.error(`no .webm recordings in ${dir}`)
  process.exit(1)
}

// The main page is created first and lives longest; the popup is the other one.
const main = videos.find((v) => path.basename(v) === 'video.webm') ?? videos[0]
const popup = videos.find((v) => v !== main)

const timingFile = path.join(dir, 'timing.json')
const timing = existsSync(timingFile) ? JSON.parse(readFileSync(timingFile, 'utf8')) : null

const common = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '25', '-movflags', '+faststart', '-an']

if (!popup || !timing?.popupOpenedAt || !timing?.testStartedAt) {
  // Nothing to overlay (or nothing to align it with): just transcode the main recording.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', main, ...common, out], { stdio: 'inherit' })
  console.log(out)
  process.exit(0)
}

// The main recording ends when the context closes (right after the test) but
// starts a few seconds into the test, so its clock runs behind wall-clock by
// (test duration − video duration). Shift the popup's wall-clock offset by
// that lag so the overlay appears at the click, not before it.
const mainDuration = Number(
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', main], { encoding: 'utf8' }).trim(),
)
const wallDuration = (timing.endedAt - timing.testStartedAt) / 1000
const lag = Number.isFinite(mainDuration) && timing.endedAt ? Math.max(0, wallDuration - mainDuration) : 0
const offsetSeconds = Math.max(0, (timing.popupOpenedAt - timing.testStartedAt) / 1000 - lag)

// The popup was recorded at the full viewport with the login card centred;
// crop to the card so it stays legible once scaled down. Top-right placement
// keeps it clear of the request card, which sits above the composer.
const filter = [
  `[1:v]crop=760:560:(iw-760)/2:(ih-560)/2,scale=608:-2,setpts=PTS-STARTPTS+${offsetSeconds.toFixed(3)}/TB[pip]`,
  `[0:v][pip]overlay=x=W-w-32:y=72:eof_action=pass:format=auto[v]`,
].join(';')

execFileSync(
  'ffmpeg',
  ['-y', '-loglevel', 'error', '-i', main, '-i', popup, '-filter_complex', filter, '-map', '[v]', ...common, out],
  { stdio: 'inherit' },
)
console.log(out)
