// Renders the Optimus mark to an .iconset. The mark is the same four-point star
// the app draws in its sidebar (frontend/src/components/Shell.tsx), so the Dock
// icon and the in-app logo are literally the same path.
import AppKit

let star: [(CGPoint, CGPoint, CGPoint)] = [
    // Four concave quarter-arcs, in the 24x24 space the SVG is authored in.
    (CGPoint(x: 12, y: 7.523), CGPoint(x: 16.477, y: 12), CGPoint(x: 22, y: 12)),
    (CGPoint(x: 16.477, y: 12), CGPoint(x: 12, y: 16.477), CGPoint(x: 12, y: 22)),
    (CGPoint(x: 12, y: 16.477), CGPoint(x: 7.523, y: 12), CGPoint(x: 2, y: 12)),
    (CGPoint(x: 7.523, y: 12), CGPoint(x: 12, y: 7.523), CGPoint(x: 12, y: 2)),
]

func render(_ size: Int) -> Data {
    let s = CGFloat(size)
    let img = NSImage(size: NSSize(width: s, height: s))
    img.lockFocus()
    let ctx = NSGraphicsContext.current!.cgContext

    // Obsidian canvas with the macOS superellipse-ish corner, so it sits in the
    // Dock like a normal app rather than a full-bleed square.
    let inset = s * 0.06
    let rect = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let bg = NSBezierPath(roundedRect: rect, xRadius: s * 0.2237, yRadius: s * 0.2237)
    NSColor(srgbRed: 0.059, green: 0.063, blue: 0.067, alpha: 1).setFill()
    bg.fill()

    // The mark, centred at 62% of the icon box.
    let markSize = rect.width * 0.62
    let scale = markSize / 24.0
    ctx.saveGState()
    ctx.translateBy(x: rect.midX - markSize / 2, y: rect.midY + markSize / 2)
    ctx.scaleBy(x: scale, y: -scale) // SVG's y-axis points down; AppKit's points up.

    let path = CGMutablePath()
    path.move(to: CGPoint(x: 12, y: 2))
    for (c1, c2, end) in star { path.addCurve(to: end, control1: c1, control2: c2) }
    path.closeSubpath()
    ctx.addPath(path)
    ctx.setFillColor(NSColor.white.cgColor)
    ctx.fillPath()
    ctx.restoreGState()

    img.unlockFocus()
    let tiff = img.tiffRepresentation!
    return NSBitmapImageRep(data: tiff)!.representation(using: .png, properties: [:])!
}

let out = CommandLine.arguments[1]
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
// The sizes iconutil expects, each in 1x and 2x.
for (name, px) in [("16x16", 16), ("32x32", 32), ("128x128", 128),
                   ("256x256", 256), ("512x512", 512)] {
    try! render(px).write(to: URL(fileURLWithPath: "\(out)/icon_\(name).png"))
    try! render(px * 2).write(to: URL(fileURLWithPath: "\(out)/icon_\(name)@2x.png"))
}
print("iconset written to \(out)")
