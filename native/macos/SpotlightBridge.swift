// The app's entries in macOS Spotlight (Core Spotlight), for the Electron main
// process. Built into libSpotlightBridge.dylib by scripts/build-macos-bridges.sh
// and called through koffi (src/main/spotlight/spotlight-bridge.ts).
//
// It has to run inside the app's own process: Spotlight files every item under
// the bundle identifier of the process that indexed it, and that is what scopes
// the results to the app in Spotlight's in-app search.
//
// One C entry point keeps the FFI surface to a single string in, string out.
// koffi runs it on a worker thread, so blocking on the completion handlers here
// never blocks the main process.

import CoreSpotlight
import Foundation
import UniformTypeIdentifiers

private struct Item: Decodable {
  let id: String
  let domain: String
  let title: String
  let subtitle: String
  let keywords: [String]
  /** Epoch milliseconds. */
  let lastUsedAt: Double?
}

private struct Changes: Decodable {
  let deleteDomains: [String]?
  let deleteIds: [String]?
  let index: [Item]?
}

private func searchable(_ item: Item) -> CSSearchableItem {
  let attributes = CSSearchableItemAttributeSet(contentType: .content)
  attributes.title = item.title
  attributes.displayName = item.title
  attributes.contentDescription = item.subtitle
  attributes.keywords = item.keywords
  if let lastUsedAt = item.lastUsedAt {
    let date = Date(timeIntervalSince1970: lastUsedAt / 1000)
    attributes.lastUsedDate = date
    attributes.contentModificationDate = date
  }
  let result = CSSearchableItem(
    uniqueIdentifier: item.id, domainIdentifier: item.domain, attributeSet: attributes)
  // The default is a month. The app reconciles the index itself at every
  // launch, so an item should last exactly as long as the thing it names.
  result.expirationDate = .distantFuture
  return result
}

/** Runs one index call to completion; nil on success, the error otherwise. */
private func complete(_ call: (@escaping (Error?) -> Void) -> Void) -> String? {
  let done = DispatchSemaphore(value: 0)
  var failure: String?
  call { error in
    if let error { failure = error.localizedDescription }
    done.signal()
  }
  if done.wait(timeout: .now() + 30) == .timedOut { return "Spotlight did not answer within 30s" }
  return failure
}

/**
 * Applies `changes` (JSON) in order: domain deletes, then id deletes, then
 * upserts. Returns NULL on success, or a malloc'd error message the caller frees.
 */
@_cdecl("spotlight_apply")
public func spotlightApply(_ json: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
  let changes: Changes
  do {
    changes = try JSONDecoder().decode(Changes.self, from: Data(String(cString: json).utf8))
  } catch {
    return strdup("Invalid changes: \(error)")
  }
  guard CSSearchableIndex.isIndexingAvailable() else { return strdup("Spotlight indexing is unavailable") }
  let index = CSSearchableIndex.default()

  if let domains = changes.deleteDomains, !domains.isEmpty,
    let error = complete({ index.deleteSearchableItems(withDomainIdentifiers: domains, completionHandler: $0) })
  {
    return strdup(error)
  }
  if let ids = changes.deleteIds, !ids.isEmpty,
    let error = complete({ index.deleteSearchableItems(withIdentifiers: ids, completionHandler: $0) })
  {
    return strdup(error)
  }
  if let items = changes.index, !items.isEmpty,
    let error = complete({ index.indexSearchableItems(items.map(searchable), completionHandler: $0) })
  {
    return strdup(error)
  }
  return nil
}
