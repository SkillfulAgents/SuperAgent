/**
 * Bundled in place of `express` (wrangler `alias`). Only Slack Bolt's ExpressReceiver loads it, and
 * the Slack connector uses Socket Mode and webhook signature checks, never that receiver. Express
 * and its body parsers are about 1.8 MB of the script, all evaluated when an isolate starts.
 */
const unavailable = () => new Error('Express is not available in a Worker')

function express(): never {
  throw unavailable()
}
express.Router = express
express.json = express
express.urlencoded = express
express.raw = express
express.text = express
express.static = express

export default express
