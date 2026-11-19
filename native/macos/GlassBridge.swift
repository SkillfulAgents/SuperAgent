// Liquid Glass behind the quick-dispatch launcher, for the Electron main
// process. Built into libGlassBridge.dylib by scripts/build-spotlight-bridge.sh
// and called through koffi (src/main/quick-dispatch-glass.ts).
//
// Electron has no Liquid Glass material: its vibrancy is NSVisualEffectView.
// The launcher window is transparent, and this puts an NSGlassEffectView
// behind its web content. NSGlassEffectView is public API from macOS 26; it is
// looked up at runtime so the dylib builds against any SDK and loads on the
// app's minimum macOS, where `glass_supported` answers false.
//
// koffi calls these synchronously on the main process's JS thread, which is
// the AppKit main thread.

import AppKit

private let backdropIdentifier = NSUserInterfaceItemIdentifier("gamut.quick-dispatch.glass")

private struct GlassConfig: Decodable {
  let cornerRadius: Double
  /// NSGlassEffectView.Style: 0 regular, 1 clear.
  let style: Int
  /// Tint for the light appearance, #RRGGBBAA.
  let tint: String?
  /// Tint for the dark appearance, #RRGGBBAA.
  let tintDark: String?
}

@_cdecl("glass_supported")
public func glassSupported() -> Bool {
  NSClassFromString("NSGlassEffectView") != nil
}

/// Puts the glass behind `viewAddress` (the NSView from
/// BrowserWindow.getNativeWindowHandle()), replacing any earlier one. Returns
/// an error message, or null.
@_cdecl("glass_apply")
public func glassApply(_ viewAddress: UInt64, _ configJSON: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
  guard Thread.isMainThread else { return strdup("glass_apply must run on the main thread") }
  guard let pointer = UnsafeRawPointer(bitPattern: UInt(viewAddress)) else { return strdup("no view") }
  let config: GlassConfig
  do {
    config = try JSONDecoder().decode(GlassConfig.self, from: Data(String(cString: configJSON).utf8))
  } catch {
    return strdup("bad config: \(error)")
  }
  // Swift can't call NSView's init(frame:) through a metatype, so make it as an
  // NSObject and size it below.
  guard let glassClass = NSClassFromString("NSGlassEffectView") as? NSObject.Type,
        let glass = glassClass.init() as? NSView
  else { return strdup("NSGlassEffectView is not available (needs macOS 26)") }

  setIfAnswered(glass, "cornerRadius", "setCornerRadius:", NSNumber(value: config.cornerRadius))
  setIfAnswered(glass, "style", "setStyle:", NSNumber(value: config.style))
  if let tint = tintColor(light: config.tint, dark: config.tintDark) {
    setIfAnswered(glass, "tintColor", "setTintColor:", tint)
  }

  let host = Unmanaged<NSView>.fromOpaque(pointer).takeUnretainedValue()
  for old in host.subviews where old.identifier == backdropIdentifier {
    old.removeFromSuperview()
  }
  glass.identifier = backdropIdentifier
  glass.frame = host.bounds
  glass.autoresizingMask = [.width, .height]
  host.addSubview(glass, positioned: .below, relativeTo: nil)
  host.window?.invalidateShadow()
  return nil
}

/// KVC set, guarded: an unknown key raises an Objective-C exception, which
/// Swift cannot catch.
private func setIfAnswered(_ object: NSObject, _ key: String, _ setter: String, _ value: Any) {
  if object.responds(to: NSSelectorFromString(setter)) {
    object.setValue(value, forKey: key)
  }
}

/// A tint that follows the window's light / dark appearance.
private func tintColor(light: String?, dark: String?) -> NSColor? {
  let lightColor = light.flatMap(color(fromHex:))
  let darkColor = dark.flatMap(color(fromHex:))
  guard let fallback = lightColor ?? darkColor else { return nil }
  return NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? (darkColor ?? fallback) : (lightColor ?? fallback)
  }
}

private func color(fromHex hex: String) -> NSColor? {
  var digits = hex.trimmingCharacters(in: .whitespaces)
  if digits.hasPrefix("#") { digits.removeFirst() }
  guard digits.count == 6 || digits.count == 8, let value = UInt64(digits, radix: 16) else { return nil }
  let rgba = digits.count == 6 ? (value << 8) | 0xFF : value
  return NSColor(
    srgbRed: CGFloat((rgba >> 24) & 0xFF) / 255,
    green: CGFloat((rgba >> 16) & 0xFF) / 255,
    blue: CGFloat((rgba >> 8) & 0xFF) / 255,
    alpha: CGFloat(rgba & 0xFF) / 255
  )
}
