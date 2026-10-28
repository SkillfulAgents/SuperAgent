import type { Config } from 'drizzle-kit'
import path from 'path'
import os from 'os'

// Mirror getDatabasePath() in src/shared/lib/config/data-dir.ts
const dbUrl = process.env.SUPERAGENT_DB_PATH
  ? path.resolve(process.env.SUPERAGENT_DB_PATH)
  : path.join(
      process.env.SUPERAGENT_DATA_DIR
        ? path.resolve(process.env.SUPERAGENT_DATA_DIR)
        : path.join(os.homedir(), '.superagent'),
      'superagent.db',
    )

export default {
  schema: './src/shared/lib/db/schema.ts',
  out: './src/shared/lib/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: dbUrl,
  },
} satisfies Config
