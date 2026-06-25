/**
 * Insert `key` at the most-recently-used position of an insertion-ordered Set,
 * evicting the oldest entries once size exceeds `max`. Keeps long-lived tracking
 * sets bounded so a connector that touches more and more threads over a
 * long-running process can't leak memory. Re-inserting an existing key refreshes
 * its recency (delete + re-add).
 */
export function touchAndCapSet(set: Set<string>, key: string, max: number): void {
  set.delete(key)
  set.add(key)
  while (set.size > max) {
    const oldest = set.values().next().value
    if (oldest === undefined) break
    set.delete(oldest)
  }
}

/** Map counterpart of {@link touchAndCapSet}: (re)inserts `key` as MRU and evicts the oldest beyond `max`. */
export function touchAndCapMap<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}
