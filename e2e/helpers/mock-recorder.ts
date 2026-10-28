import * as fs from 'fs'
import * as path from 'path'

/**
 * Reader for `.e2e-mock-recorder.jsonl` — the JSONL file MockContainerClient
 * appends to under the active data dir, and the only way a spec can see the
 * runtime options the renderer actually sent through the full API path (there
 * is deliberately no HTTP endpoint that returns them).
 *
 * Seven specs grew their own copy of this and drifted: some guarded the parse,
 * some did not, and the ones that did not turn a routine partial write into a
 * SyntaxError. Three traps are baked in here so nobody has to rediscover them:
 *
 *  1. The app appends WHILE a spec polls, so the final line can be read
 *     half-written. Unparseable lines are skipped, not thrown on — the next
 *     poll sees the complete line.
 *  2. The file is shared across workers and tests, so it never starts empty.
 *     A predicate MUST filter on something test-unique (a generated agent
 *     slug, a unique initial message) rather than assume isolation.
 *  3. The path has to be derived the way the Playwright config derives the
 *     data dir, including any per-project subdirectory. Handling only the
 *     SUPERAGENT_DATA_DIR branch or only the fallback passes locally and fails
 *     in CI, or the reverse, depending on which one sets the variable.
 */

const RECORDER_FILENAME = '.e2e-mock-recorder.jsonl'

/** The fields every recorder consumer relies on; specs narrow this further. */
export interface MockRecordBase {
  type: string
  agentSlug?: string
}

export interface MockRecorderOptions {
  /**
   * Data dir to use when SUPERAGENT_DATA_DIR is unset — i.e. the same default
   * the spec's Playwright config falls back to. Defaults to the main suite's.
   */
  defaultDataDir?: string
  /**
   * Per-project subdirectory beneath the data dir, for configs that give each
   * project its own (the auth suite does). Omit when the config does not.
   */
  subdir?: string
}

export interface WaitForRecordOptions {
  timeoutMs?: number
  /** Named in the timeout message, e.g. "container_start for agent-7". */
  label?: string
}

export interface MockRecorder<T extends MockRecordBase> {
  /** Absolute path to the JSONL file, for diagnostics. */
  readonly file: string
  /** Every record written so far; skips a torn final line. */
  read(): T[]
  /** Poll until one record matches, or throw with the tail of what was seen. */
  waitFor(predicate: (record: T) => boolean, options?: WaitForRecordOptions): Promise<T>
}

export function mockRecorder<T extends MockRecordBase>(
  options: MockRecorderOptions = {},
): MockRecorder<T> {
  const { defaultDataDir = '.e2e-data', subdir } = options
  // `path.resolve` lets SUPERAGENT_DATA_DIR be absolute or relative to cwd.
  const base = path.resolve(process.cwd(), process.env.SUPERAGENT_DATA_DIR ?? defaultDataDir)
  const file = path.join(subdir ? path.join(base, subdir) : base, RECORDER_FILENAME)

  const read = (): T[] => {
    if (!fs.existsSync(file)) return []
    return fs
      .readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T]
        } catch {
          // Trap 1: a partially-written final line. Drop it and let the next
          // poll read it whole.
          return []
        }
      })
  }

  const waitFor = async (
    predicate: (record: T) => boolean,
    { timeoutMs = 12000, label }: WaitForRecordOptions = {},
  ): Promise<T> => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const found = read().find(predicate)
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const subject = label ? ` for ${label}` : ''
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for a mock record${subject}. `
      + `Last records seen: ${JSON.stringify(read().slice(-10), null, 2)}`,
    )
  }

  return { file, read, waitFor }
}
