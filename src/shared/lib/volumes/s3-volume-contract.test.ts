import { afterEach, vi } from 'vitest'
import { volumeContract } from './testing/volume-contract'
import { s3Fixture } from './testing/s3-fixture'
vi.mock('@shared/lib/proxy/audit', () => ({ writeProxyAuditEntry: async () => {} }))
afterEach(() => vi.restoreAllMocks())
volumeContract('S3', s3Fixture)
