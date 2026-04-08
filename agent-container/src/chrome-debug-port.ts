import * as fs from 'fs';
import * as path from 'path';

/**
 * Read Chrome's CDP port from the DevToolsActivePort file in the profile dir.
 * agent-browser launches Chrome with --remote-debugging-port=0 (dynamic port),
 * and Chrome writes the assigned port to this file.
 *
 * @param profileDir - Path to Chrome's user-data-dir (profile directory)
 * @returns The port number, or null if the file is missing/invalid
 */
export function readChromeDebugPort(profileDir?: string): number | null {
  const profile = profileDir || process.env.AGENT_BROWSER_PROFILE || '/workspace/.browser-profile';
  try {
    const content = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf-8');
    const port = parseInt(content.split('\n')[0], 10);
    return isNaN(port) ? null : port;
  } catch {
    return null;
  }
}
