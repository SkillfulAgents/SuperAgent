/** `superagent://explore` — open the featured-templates marketplace. */
export function isExploreDeepLink(url: string, scheme: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${scheme}:`) return false
    const host = parsed.hostname.toLowerCase()
    const path = parsed.pathname.replace(/\/+$/, "")
    if (host === "explore") return path === ""
    return host === "open" && path === "/explore"
  } catch {
    return false
  }
}
