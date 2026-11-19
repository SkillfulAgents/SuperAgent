/**
 * The container's own Chrome can render at 2x (BROWSER_HIGH_DPI, from the "High-Resolution
 * Rendering" setting), which gives the preview more pixels to show. Pages keep their CSS
 * size, so refs and `mouse` coordinates mean what they did.
 *
 * `--screen-info` instead of `--force-device-scale-factor`: with that flag, a page reads a
 * screen half the size of its own window. The screen here is 1280×720 in CSS pixels, as it
 * is at 1x.
 */

const HIGH_DPI_SCALE = 2;
const HIGH_DPI_ARG = `--screen-info={2560x1440 devicePixelRatio=${HIGH_DPI_SCALE}}`;

/** The ratio Chrome renders at when 2x is on; undefined when it's left at its default. */
export function browserScale(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return env.BROWSER_HIGH_DPI === '1' ? HIGH_DPI_SCALE : undefined;
}

/**
 * Call once at server startup, before any browser command can run. It goes in the process
 * environment because agent-browser relaunches Chrome, losing the agent's tabs, when a call
 * arrives with other args than the running browser's, and an agent's Bash calls inherit from here.
 */
export function pinBrowserScaleArgs(env: NodeJS.ProcessEnv = process.env): void {
  if (browserScale(env)) env.AGENT_BROWSER_ARGS = [env.AGENT_BROWSER_ARGS, HIGH_DPI_ARG].filter(Boolean).join(',');
}
