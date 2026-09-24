import { z } from 'zod'

/** Provider-independent JSON boundary. Providers validate their own credential shape. */
export const integrationConfigSchema = z.record(z.string(), z.json().optional())
