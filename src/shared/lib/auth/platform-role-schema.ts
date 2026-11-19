import { z } from 'zod'

// A member's org role as the platform sends it: the `member_role` enum in the
// platform's database, carried by the id_token role claim and the desktop
// grant's `role`.
export const PlatformOrgRoleSchema = z.enum(['owner', 'admin', 'member'])
