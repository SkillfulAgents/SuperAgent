import { createInMemorySessionIndexStorage } from './in-memory-session-index-storage'
import { describeSessionIndexStorageContract } from './session-index-storage-contract'

describeSessionIndexStorageContract('InMemorySessionIndexStorage', () => ({
  storage: createInMemorySessionIndexStorage(),
  other: createInMemorySessionIndexStorage(),
}))
