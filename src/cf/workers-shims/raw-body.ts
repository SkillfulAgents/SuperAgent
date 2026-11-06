/**
 * Bundled in place of `raw-body` (wrangler `alias`). Slack Bolt reads request bodies with it only in
 * its HTTP receivers, which a Worker does not use; leaving it out also leaves out iconv-lite's tables.
 */
export default function getRawBody(): never {
  throw new Error('raw-body is not available in a Worker')
}
