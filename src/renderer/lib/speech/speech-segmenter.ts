import type { SpokenWord } from './spoken-words'

/**
 * A run of words sent to the synthesizer as one batch (one Speak + Flush).
 * `wordStart`/`wordEnd` index into the full word list, half-open.
 */
export interface SpeechSegment {
  text: string
  wordStart: number
  wordEnd: number
}

/** A sentence shorter than this is merged into the next one ("1.", "e.g."). */
const MIN_SENTENCE_WORDS = 3
/** Past this many words, a clause boundary (comma, semicolon, colon) is good enough. */
const SOFT_MAX_WORDS = 40
/** Never send more than this in one batch, boundary or not. */
const HARD_MAX_WORDS = 80

const SENTENCE_END = /[.!?…]["'”’)\]]*$/u
const CLAUSE_END = /[,;:]["'”’)\]]*$/u
/** Dotted abbreviations whose period is not a sentence end: e.g., i.e., U.S. */
const DOTTED_ABBREVIATION = /^(?:\p{L}\.)+\p{L}?\.?$/u
const COMMON_ABBREVIATIONS = new Set(['etc.', 'vs.', 'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.', 'no.', 'approx.'])

function endsSentence(word: string): boolean {
  if (!SENTENCE_END.test(word)) return false
  const bare = word.replace(/["'”’)\]]+$/u, '').toLowerCase()
  return !DOTTED_ABBREVIATION.test(bare) && !COMMON_ABBREVIATIONS.has(bare)
}

/**
 * Cuts a stream of words into synthesizer batches. Sentence-sized batches keep
 * time-to-first-audio short and give the playback highlight a boundary it can
 * trust: the server reports when each batch's audio is complete, so a segment
 * is the unit at which spoken position is known exactly.
 *
 * Push-based so it works the same for a finished message and for text that
 * is still streaming in.
 */
export class SpeechSegmenter {
  private pending: SpokenWord[] = []
  private pendingStart = 0
  private nextWord = 0

  /** Feed words; returns whichever segments became complete. */
  push(words: readonly SpokenWord[]): SpeechSegment[] {
    const out: SpeechSegment[] = []
    for (const word of words) {
      this.pending.push(word)
      this.nextWord++
      if (this.shouldCut(word)) out.push(this.cut())
    }
    return out
  }

  /** No more words are coming: return the trailing partial segment, if any. */
  end(): SpeechSegment[] {
    return this.pending.length > 0 ? [this.cut()] : []
  }

  private shouldCut(last: SpokenWord): boolean {
    const count = this.pending.length
    if (last.blockEnd) return true
    if (count >= HARD_MAX_WORDS) return true
    if (count >= MIN_SENTENCE_WORDS && endsSentence(last.text)) return true
    if (count >= SOFT_MAX_WORDS && CLAUSE_END.test(last.text)) return true
    return false
  }

  private cut(): SpeechSegment {
    const segment: SpeechSegment = {
      text: this.pending.map((w) => w.text).join(' '),
      wordStart: this.pendingStart,
      wordEnd: this.nextWord,
    }
    this.pending = []
    this.pendingStart = this.nextWord
    return segment
  }
}
