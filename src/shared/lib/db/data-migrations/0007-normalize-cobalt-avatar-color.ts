import { eq } from 'drizzle-orm'
import { agents } from '../schema'
import type { DataMigration } from './index'

/** Early avatar previews persisted the display label instead of the tonal ID. */
export const normalizeCobaltAvatarColor: DataMigration = {
  id: 7,
  name: 'normalize-cobalt-avatar-color',
  async run(db) {
    await db.update(agents).set({ avatarColor: 'tonal-cobalt' })
      .where(eq(agents.avatarColor, 'Cobalt')).run()
  },
}
