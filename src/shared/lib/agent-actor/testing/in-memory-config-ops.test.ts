import { describeConfigOpsContract } from './config-ops-contract'
import { createInMemoryConfigOps } from './in-memory-config-ops'
import { InMemoryFileOps } from './in-memory-file-ops'

describeConfigOpsContract('InMemoryConfigOps', () => {
  const files = new InMemoryFileOps()
  return { files, config: createInMemoryConfigOps(files) }
})
