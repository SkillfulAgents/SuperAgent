import type { KeyObject } from 'crypto'
import type { KeyProbeResult, KeyProbes } from '../key-manager'

/**
 * A probe standing in for the sealed data: nothing sealed, or sealed under
 * one key (what the data would open with).
 */
export class FakeSealedData {
  sealedUnder: Buffer | null = null
  calls = 0

  probe = async (key: KeyObject): Promise<KeyProbeResult> => {
    this.calls++
    if (!this.sealedUnder) return 'nothing-sealed'
    return key.export().equals(this.sealedUnder) ? 'opens' : 'does-not-open'
  }

  get probes(): KeyProbes {
    return { 'browser-vault': this.probe }
  }
}

/** A log that keeps its lines, for asserting nothing secret reached it. */
export function memoryLog(): { lines: string[]; info(message: string): void; warn(message: string): void } {
  const lines: string[] = []
  return { lines, info: (message) => lines.push(message), warn: (message) => lines.push(message) }
}
