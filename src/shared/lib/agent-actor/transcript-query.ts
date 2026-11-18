import type { JsonlMessageEntry, JsonlSystemEntry } from '@shared/lib/types/agent'
import { userRequestText } from '@shared/lib/utils/user-request-text'
import type { TranscriptEntryQuery } from './types'

/** The entries a transcript query names. */
export function matchesTranscriptQuery(query: TranscriptEntryQuery): (entry: JsonlMessageEntry | JsonlSystemEntry) => boolean {
  switch (query.kind) {
    case 'user':
      return (entry) => entry.type === 'user' && entry.uuid === query.uuid
    case 'assistant':
      return (entry) => entry.type === 'assistant'
    case 'user-request':
      return (entry) => userRequestText(entry) !== null
  }
}
