import type { Config } from 'drizzle-kit'
import path from 'path'
import os from 'os'

// Get data directory (same logic as src/lib/config/data-dir.ts)
const dataDir = process.env.SUPERAGENT_DATA_DIR
  ? path.resolve(process.env.SUPERAGENT_DATA_DIR)
  : path.join(os.homedir(), '.superagent')

export default {
  schema: './src/shared/lib/db/schema.ts',
  out: './src/shared/lib/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: path.join(dataDir, 'superagent.db'),
  },
} satisfies Config
