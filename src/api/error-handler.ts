import type { ErrorHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'

/**
 * Global API error handler. Hono's own middleware refuses a request by
 * throwing an HTTPException (bodyLimit's 413, the validator's 400 for
 * malformed JSON), so those keep their status, in this API's `{ error }`
 * shape. Anything else is a server fault and stays an opaque 500.
 */
export const apiErrorHandler: ErrorHandler = async (err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message || await err.getResponse().text() }, err.status)
  }
  console.error('API Error:', err)
  return c.json({ error: 'Internal server error' }, 500)
}
