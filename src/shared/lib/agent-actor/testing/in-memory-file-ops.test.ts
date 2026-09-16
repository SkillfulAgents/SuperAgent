import { describeFileOpsContract } from './file-ops-contract'
import { InMemoryFileOps } from './in-memory-file-ops'

describeFileOpsContract('InMemoryFileOps', () => ({ files: new InMemoryFileOps() }))
