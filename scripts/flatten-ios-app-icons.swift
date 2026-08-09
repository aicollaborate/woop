import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// App Store Connect rejects iOS AppIcon PNGs that carry an alpha channel.
// Tauri's iOS generator produces rounded-corner icons with transparent outer
// pixels, so composite every generated size on Flowix's existing cream color.
let background = CGColor(srgbRed: 1.0, green: 0.94, blue: 0.79, alpha: 1.0)
let fileManager = FileManager.default

for path in CommandLine.arguments.dropFirst() {
  let input = URL(fileURLWithPath: path)
  guard let image = NSImage(contentsOf: input),
        let source = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
    fatalError("Cannot read iOS AppIcon: \(path)")
  }

  let width = source.width
  let height = source.height
  // First composite in an alpha-capable AppKit context. Drawing the original
  // transparent PNG directly into a no-alpha CoreGraphics bitmap can turn its
  // transparent pixels white instead of preserving the filled background.
  guard let compositingBitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: width,
    pixelsHigh: height,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ), let compositingContext = NSGraphicsContext(bitmapImageRep: compositingBitmap) else {
    fatalError("Cannot create compositing bitmap for: \(path)")
  }

  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = compositingContext
  NSColor(srgbRed: 1.0, green: 0.94, blue: 0.79, alpha: 1.0).setFill()
  NSRect(x: 0, y: 0, width: width, height: height).fill()
  NSImage(cgImage: source, size: NSSize(width: width, height: height)).draw(
    in: NSRect(x: 0, y: 0, width: width, height: height),
    from: .zero,
    operation: .sourceOver,
    fraction: 1.0
  )
  NSGraphicsContext.restoreGraphicsState()

  // Some Tauri-generated PNGs carry transparent pixels with white RGB data.
  // AppKit preserves those RGB bytes while composing, so normalize the white
  // matte to the intended cream background before dropping the alpha channel.
  let compositingBytesPerRow = compositingBitmap.bytesPerRow
  if let pixels = compositingBitmap.bitmapData {
    let bytesPerRow = compositingBytesPerRow
    for y in 0..<height {
      for x in 0..<width {
        let offset = y * bytesPerRow + x * 4
        if pixels[offset] > 247 && pixels[offset + 1] > 247 && pixels[offset + 2] > 247 {
          pixels[offset] = 255
          pixels[offset + 1] = 240
          pixels[offset + 2] = 201
          pixels[offset + 3] = 255
        }
      }
    }
  }

  // The compositing bitmap is fully opaque. Reinterpret its exact RGB bytes
  // without the alpha channel rather than redrawing it into a no-alpha
  // context, which can incorrectly turn formerly-transparent pixels white.
  guard let composited = compositingBitmap.cgImage,
        let provider = composited.dataProvider,
        let output = CGImage(
          width: width,
          height: height,
          bitsPerComponent: 8,
          bitsPerPixel: 32,
          bytesPerRow: compositingBytesPerRow,
          space: colorSpace,
          bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
          provider: provider,
          decode: nil,
          shouldInterpolate: true,
          intent: .defaultIntent
        ) else {
    fatalError("Cannot finalize opaque iOS AppIcon: \(path)")
  }
  let temporary = input.deletingPathExtension().appendingPathExtension("opaque.png")
  guard let destination = CGImageDestinationCreateWithURL(
    temporary as CFURL,
    UTType.png.identifier as CFString,
    1,
    nil
  ) else {
    fatalError("Cannot encode iOS AppIcon: \(path)")
  }
  CGImageDestinationAddImage(destination, output, nil)
  guard CGImageDestinationFinalize(destination) else {
    fatalError("Cannot write iOS AppIcon: \(path)")
  }
  try fileManager.removeItem(at: input)
  try fileManager.moveItem(at: temporary, to: input)
}
