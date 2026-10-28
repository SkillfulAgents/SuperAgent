const CHROME_HTML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
};

/**
 * Chrome HTML-escapes page titles returned by its `/json` discovery endpoint.
 * Undo exactly that escaping before forwarding the title to the browser preview.
 */
export function decodeChromeTargetTitle(title: string): string {
  return title.replace(/&(lt|gt|amp|quot|#39);/g, entity => CHROME_HTML_ENTITIES[entity]);
}
