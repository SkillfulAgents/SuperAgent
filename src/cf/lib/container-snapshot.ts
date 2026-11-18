/**
 * Starting an agent's container from a container snapshot instead of the image. A host that has
 * the snapshot's layers starts it in under a second, and no host has to pull the image. A
 * deployment that keeps such a snapshot names it in one variable (CONTAINER_SNAPSHOT, JSON with
 * its id, name and size); with none, containers start from the image.
 *
 * What the snapshot holds is a contract with whatever builds it: a base system with the agent
 * image's root file system under /img. A snapshot start applies neither the image's environment
 * nor its working directory, so the start command sets both and enters /img.
 */

/** A container snapshot's handle, as Cloudflare gives it when the snapshot is made. */
export interface ContainerSnapshot {
  id: string
  name: string
  size: number
}

/** Where the snapshot keeps the agent image's root file system. */
const IMAGE_ROOT = '/img'
/** The agent image's WORKDIR. */
const IMAGE_WORKDIR = '/app'

/**
 * The agent image's environment (agent-container/Dockerfile, and its base image's PATH). The test
 * checks it against the Dockerfile, so a variable added there cannot be missed here.
 */
export const IMAGE_ENV: Record<string, string> = {
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  DEBIAN_FRONTEND: 'noninteractive',
  PLAYWRIGHT_BROWSERS_PATH: '/opt/playwright-browsers',
  NODE_ENV: 'production',
  PORT: '3000',
  HOME: '/home/claude',
  CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
  AGENT_BROWSER_STREAM_PORT: '9223',
  AGENT_BROWSER_EXECUTABLE_PATH: '/opt/playwright-browsers/chromium-current',
  AGENT_BROWSER_ARGS: '--no-sandbox,--disable-dev-shm-usage,--disable-blink-features=AutomationControlled,--disable-features=AutomationControlled,--disable-infobars,--disable-background-timer-throttling,--disable-popup-blocking,--disable-backgrounding-occluded-windows,--disable-renderer-backgrounding,--disable-component-update',
  AGENT_BROWSER_USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  AGENT_BROWSER_PROFILE: '/workspace/.browser-profile',
  AGENT_BROWSER_DOWNLOAD_PATH: '/workspace/downloads',
  AGENT_BROWSER_IDLE_TIMEOUT_MS: '0',
  AGENT_BROWSER_NO_WEBMCP: '1',
  AGENT_BROWSER_NO_VERSION_CHECK: '1',
  DISABLE_AUTOUPDATER: '1',
  BUN_INSTALL_CACHE_DIR: '/workspace/.bun-cache',
}

/**
 * The deployment's snapshot from its variable, or null when the variable is unset or empty.
 * Throws on a value that is not a snapshot handle, so a wrong one is noticed, not ignored.
 */
export function containerSnapshotFrom(json: string | undefined): ContainerSnapshot | null {
  if (!json?.trim()) return null
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    throw new Error('CONTAINER_SNAPSHOT is not valid JSON', { cause: error })
  }
  const { id, name, size } = (value ?? {}) as Record<string, unknown>
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name || typeof size !== 'number' || !Number.isFinite(size)) {
    throw new Error('CONTAINER_SNAPSHOT must be a JSON object with an id, a name and a size')
  }
  return { id, name, size }
}

const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/**
 * What a container started from the snapshot runs in place of the image's `command`: it gives the
 * image's file system the mounts and host files a running system has, then runs `command` inside
 * it with the image's environment and working directory.
 */
export function snapshotStartCommand(command: readonly string[]): string[] {
  const env = Object.entries(IMAGE_ENV).map(([key, value]) => quoted(`${key}=${value}`)).join(' ')
  const inImage = `cd ${IMAGE_WORKDIR} && exec ${command.map(quoted).join(' ')}`
  return ['sh', '-c', [
    `for d in proc sys dev tmp; do mkdir -p ${IMAGE_ROOT}/$d; done`,
    `mount -t proc proc ${IMAGE_ROOT}/proc || true`,
    `mount --rbind /sys ${IMAGE_ROOT}/sys || true`,
    `mount --rbind /dev ${IMAGE_ROOT}/dev || true`,
    `chmod 1777 ${IMAGE_ROOT}/tmp`,
    `cp /etc/resolv.conf ${IMAGE_ROOT}/etc/resolv.conf 2>/dev/null || true`,
    // An exported image has an empty /etc/hosts (a container runtime fills it at run time), so localhost would not resolve.
    `cp /etc/hosts ${IMAGE_ROOT}/etc/hosts 2>/dev/null || true`,
    `grep -qw localhost ${IMAGE_ROOT}/etc/hosts || printf "127.0.0.1 localhost\\n::1 localhost ip6-localhost ip6-loopback\\n" >> ${IMAGE_ROOT}/etc/hosts`,
    `cp /etc/hostname ${IMAGE_ROOT}/etc/hostname 2>/dev/null || true`,
    `exec chroot ${IMAGE_ROOT} env ${env} sh -c ${quoted(inImage)}`,
  ].join('; ')]
}
