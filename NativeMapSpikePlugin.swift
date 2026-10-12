//
//  NativeMapSpikePlugin.swift
//  Theme Park CP — native map SPIKE (Claude msg 142, step 1 of 5)
//
//  Sole purpose: prove that a native compositor (Core Animation) does
//  not produce the beige band that five instrumented rounds traced to
//  WKWebView's tile-pane rasterization. This file is a bare tiled view:
//  the resort fit rendered from the extracted tile PNGs, pan + pinch
//  zoom, an in-process diagnostic readout, and NOTHING else — no pins,
//  no chips, no directions (those are steps 3–5, gated on this spike's
//  device verdict).
//
//  Registration (CORRECTED Oct 10, 2026): Capacitor does NOT
//  auto-discover plugins that live in the app target -- the bridge only
//  loads its built-ins plus the packageClassList cap sync writes from
//  npm packages. The first device build proved it: the class compiled
//  and linked, and the Info tab honestly reported the plugin as not
//  registered in this build. Registration is therefore EXPLICIT:
//  NativeMapSpikeBridgeViewController (bottom of this file) registers
//  an instance in capacitorDidLoad(), and SceneDelegate + the Main
//  storyboard both instantiate that subclass as the bridge host.
//  JS reaches it as Capacitor.Plugins.NativeMapSpike.
//
//  Tiles: the app bundle must contain the extracted pack as a folder
//  named "tiles" (repo path tiles/resort/<z>/<x>/<y>.png +
//  tiles/manifest.json, produced by scripts/extract-resort-tiles.py).
//  It lands there via the "Copy Tiles Folder" script phase in the
//  Xcode project (an rsync of the repo tiles/ tree into the .app) --
//  Xcode 27's Add Files "Create folders" is a synchronized folder, not
//  a folder reference, and flattens every PNG into the bundle root.
//  If the folder is absent the view still opens (all beige) and the
//  readout says so — an honest failure, never a silent one.
//

import UIKit
import Capacitor
import QuartzCore

/// Step 10 (msg 168): wall-clock milliseconds for the
/// first-open cold instrument. The JS side stamps tap/prep
/// with Date.now(), so both sides read the same device
/// wall clock.
private func spikeWallMsNow() -> Double {
    Date().timeIntervalSince1970 * 1000.0
}

// MARK: - Geometry ported from the web map (app.html)
//
// Web sources (repo app.html @ the msg-142 build):
//   TPCP_RESORT_BOUNDS    = [[33.8020, -117.9300], [33.8172, -117.9142]]
//   TPCP_RESORT_MAXBOUNDS = [[33.8008, -117.9312], [33.8184, -117.9130]]
//   full map: L.map(..., { minZoom: 13, maxZoom: 19,
//             maxBounds: TPCP_RESORT_MAXBOUNDS, maxBoundsViscosity: 1.0 })
//             then map.fitBounds(TPCP_RESORT_BOUNDS)
//   layer:    tileSize 256, zoomOffset -1  =>  dict key for the tile
//             shown at map zoom m is "z/x/y" with z = m - 1 and x/y in
//             the standard slippy grid AT zoom m. Equivalently, dict
//             key (z, x, y) is the standard 256px tile at zoom z + 1.
//
// The native view's coordinate space is the standard slippy pixel
// space at zoom 19 (the finest dict level, key z18): 1 view point =
// 1 px of the sharpest imagery, nothing is ever upscaled. Displaying
// map zoom m means scroll scale 2^(m-19).
private enum SpikeGeom {
    static let boundsSW = (lat: 33.8020, lng: -117.9300)
    static let boundsNE = (lat: 33.8172, lng: -117.9142)
    static let maxSW = (lat: 33.8008, lng: -117.9312)
    static let maxNE = (lat: 33.8184, lng: -117.9130)
    static let minMapZoom = 13
    static let maxMapZoom = 19
    static let refZoom = 19

    static func pxX(lng: Double, zoom: Double) -> Double {
        return (lng + 180.0) / 360.0 * 256.0 * pow(2.0, zoom)
    }
    static func pxY(lat: Double, zoom: Double) -> Double {
        let r = lat * Double.pi / 180.0
        return (1.0 - asinh(tan(r)) / Double.pi) / 2.0 * 256.0 * pow(2.0, zoom)
    }
    static func globalPx(lat: Double, lng: Double) -> CGPoint {
        return CGPoint(x: pxX(lng: lng, zoom: Double(refZoom)),
                       y: pxY(lat: lat, zoom: Double(refZoom)))
    }

    // Port of Leaflet 1.9 Map.getBoundsZoom(bounds, inside=false,
    // padding=0) as fitBounds() invokes it at map creation (current
    // zoom 0): project the bounds at zoom 0, take the min axis scale
    // against the viewport, convert with getScaleZoom (log2), apply
    // zoomSnap=1 exactly as Leaflet does (round to 1% of a snap, then
    // floor), and clamp to [minZoom, maxZoom].
    // Validation of this port against known device facts: viewport
    // 402x874 and 402x751 both yield 15 (the beacon-proven web fit on
    // Beau's phone); 320x568 yields 14 (the band rounds' derivation).
    static func leafletFitZoom(viewport: CGSize) -> Int {
        let nwX = pxX(lng: boundsSW.lng, zoom: 0)
        let nwY = pxY(lat: boundsNE.lat, zoom: 0)
        let seX = pxX(lng: boundsNE.lng, zoom: 0)
        let seY = pxY(lat: boundsSW.lat, zoom: 0)
        let bw = abs(seX - nwX)
        let bh = abs(seY - nwY)
        if bw <= 0 || bh <= 0 || viewport.width <= 0 || viewport.height <= 0 {
            return 15
        }
        let scale = min(Double(viewport.width) / bw, Double(viewport.height) / bh)
        var z = log2(scale)
        z = (z / 0.01).rounded() * 0.01   // Leaflet's 1%-of-snap rounding
        z = floor(z)                       // zoomSnap 1, fit is "inside=false"
        return Int(min(Double(maxMapZoom), max(Double(minMapZoom), z)))
    }

    // TPCPRouter.havFt transcribed (R 6371000 m, 3.28084 ft/m): the
    // step-4 transit check -- native re-derives the route's coordFt
    // from the received lat/lons before projecting them.
    static func havFt(lat1: Double, lon1: Double, lat2: Double, lon2: Double) -> Double {
        let r = 6371000.0
        let p1 = lat1 * Double.pi / 180.0, p2 = lat2 * Double.pi / 180.0
        let dp = (lat2 - lat1) * Double.pi / 180.0, dl = (lon2 - lon1) * Double.pi / 180.0
        let h = sin(dp / 2.0) * sin(dp / 2.0) + cos(p1) * cos(p2) * sin(dl / 2.0) * sin(dl / 2.0)
        return 2.0 * r * asin(sqrt(h)) * 3.28084
    }
}

// MARK: - Tile source (step 7 cleanup: the CATiledLayer display
// path that used to be configured here -- SpikeTiledLayer, the
// tileSize grid port, draw() -- is retired; the design doc's
// keep/delete map is the proof. What remains is the tile ladder +
// decode cache the layer engine and the mini-map render consume.
// This class is never displayed.)

final class SpikeTiledView: UIView {

    /// .../tiles/resort inside the app bundle (nil if the folder is absent).
    var tilesRoot: URL?
    /// Global zoom-19 px coordinates of this view's top-left corner
    /// (the MAXBOUNDS north-west corner). View-local + origin = global.
    var originGlobal: CGPoint = .zero
    /// Map zoom the cell painter (paintCells) resolves at
    /// (13...19). Only renderMiniMap sets it now -- the layer
    /// engine takes its level as a parameter (layerTile /
    /// resolution). The step-5 tileSize grid alignment that used
    /// to hang off this property's didSet was display machinery
    /// for the retired CATiledLayer path (step 7 cleanup).
    var level: Int = 15

    private let imageCache = NSCache<NSString, UIImage>()
    private let countLock = NSLock()
    // Draw counters of the retired display path. paintCells is
    // their only writer, and it now runs only inside
    // renderMiniMap (throwaway instance, count: false), so on
    // every live instance these read exactly 0 forever -- both
    // view controllers' instruments keep reading them as the
    // standing proof that no tile is rasterized for display.
    // The painted-cell set that used to sit here (paintedCells /
    // wasPainted / markPainted) lost its last reader when step 6
    // moved the census to the layer dict; step 7 deletes it.
    private(set) var drawnExact: Int = 0
    private(set) var drawCalls: Int = 0

    /// The web layer's fallback background (app.html createTile:
    /// img.style.background = '#EFEDE7'). Genuinely out-of-coverage
    /// cells (the pan margin outside the resort frame) paint this.
    static let beige = UIColor(red: 0xEF / 255.0, green: 0xED / 255.0,
                               blue: 0xE7 / 255.0, alpha: 1.0)

    override init(frame: CGRect) {
        super.init(frame: frame)
        commonInit()
    }
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }
    private func commonInit() {
        // Step 7 cleanup: the CATiledLayer configuration that
        // used to live here (tileSize grid alignment,
        // levelsOfDetail, the fade subclass) configured a display
        // layer this class no longer has -- it is never displayed.
        contentScaleFactor = UIScreen.main.scale
        backgroundColor = SpikeTiledView.beige
        imageCache.countLimit = 512
    }

    /// Bundle lookup for tiles/resort (the VC's locateTiles keeps
    /// its own status-reporting variant; the mini render needs only
    /// the URL).
    static func locateResortTiles() -> URL? {
        var tilesURL = Bundle.main.url(forResource: "tiles", withExtension: nil)
        if tilesURL == nil, let res = Bundle.main.resourceURL {
            let candidate = res.appendingPathComponent("tiles")
            if FileManager.default.fileExists(atPath: candidate.path) {
                tilesURL = candidate
            }
        }
        guard let base = tilesURL else { return nil }
        let resort = base.appendingPathComponent("resort")
        return FileManager.default.fileExists(atPath: resort.path) ? resort : nil
    }

    /// Step 5: the Co-Pilot mini-map, rendered natively -- a
    /// synchronous pass of this view's own cell painter at the mini
    /// viewport's fit level, in a context pre-scaled so the
    /// painter's zoom-19 coordinates land in points: the same
    /// tiles, ladder, and geometry as the live view. (A live
    /// CATiledLayer rasterizes asynchronously and cannot be
    /// snapshotted deterministically.) The pins are the web
    /// mini-map's marker set (graph places + services) in its
    /// styles, passed in by the web.
    static func renderMiniMap(size: CGSize,
                              pins: [(lat: Double, lon: Double, fill: UIColor, radius: CGFloat, weight: CGFloat)]) -> UIImage? {
        guard size.width > 0, size.height > 0,
              let root = locateResortTiles() else { return nil }
        let level = SpikeGeom.leafletFitZoom(viewport: size)
        let s = pow(2.0, Double(level - SpikeGeom.refZoom))
        let cLat = (SpikeGeom.boundsSW.lat + SpikeGeom.boundsNE.lat) / 2.0
        let cLng = (SpikeGeom.boundsSW.lng + SpikeGeom.boundsNE.lng) / 2.0
        let c = SpikeGeom.globalPx(lat: cLat, lng: cLng)
        let visW = Double(size.width) / s, visH = Double(size.height) / s
        let origin = CGPoint(x: c.x - CGFloat(visW / 2.0), y: c.y - CGFloat(visH / 2.0))
        let view = SpikeTiledView(frame: CGRect(origin: .zero, size: size))
        view.tilesRoot = root
        view.originGlobal = origin
        view.level = level
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { rc in
            let ctx = rc.cgContext
            SpikeTiledView.beige.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            ctx.saveGState()
            ctx.scaleBy(x: CGFloat(s), y: CGFloat(s))
            view.paintCells(in: CGRect(x: 0, y: 0, width: CGFloat(visW), height: CGFloat(visH)),
                            ctx: ctx, count: false)
            ctx.restoreGState()
            for p in pins {
                let gp = SpikeGeom.globalPx(lat: p.lat, lng: p.lon)
                let cx = (Double(gp.x) - Double(origin.x)) * s
                let cy = (Double(gp.y) - Double(origin.y)) * s
                let r = Double(p.radius)
                let circle = CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2)
                ctx.setFillColor(p.fill.withAlphaComponent(0.95).cgColor)
                ctx.fillEllipse(in: circle)
                ctx.setStrokeColor(UIColor.white.cgColor)
                ctx.setLineWidth(p.weight)
                ctx.strokeEllipse(in: circle.insetBy(dx: Double(p.weight) / 2.0,
                                                     dy: Double(p.weight) / 2.0))
            }
        }
    }

    // MARK: tile lookup — the web createTile ladder, keys identical

    private func tileURL(z: Int, x: Int, y: Int) -> URL? {
        return tilesRoot?.appendingPathComponent("\(z)/\(x)/\(y).png")
    }
    func tileExists(z: Int, x: Int, y: Int) -> Bool {
        guard let u = tileURL(z: z, x: x, y: y) else { return false }
        return FileManager.default.fileExists(atPath: u.path)
    }
    private func tileImage(z: Int, x: Int, y: Int) -> UIImage? {
        let key = "\(z)/\(x)/\(y)" as NSString
        if let hit = imageCache.object(forKey: key) { return hit }
        guard let u = tileURL(z: z, x: x, y: y),
              let img = UIImage(contentsOfFile: u.path) else { return nil }
        imageCache.setObject(img, forKey: key)
        return img
    }
    /// How a level-`level` tile (tx, ty) resolves, mirroring createTile:
    /// exact key z = level-1; on a miss walk z-1 then z-2 with the
    /// coordinates halved (floor) per step; absent at every level is a
    /// hard miss. Returns 0 = exact, 1 = substituted, 2 = missing.
    func resolution(z: Int, x: Int, y: Int) -> Int {
        if tileExists(z: z, x: x, y: y) { return 0 }
        var az = z, ax = x, ay = y
        for _ in 0..<2 {
            az -= 1; ax /= 2; ay /= 2
            if az < 0 { break }
            if tileExists(z: az, x: ax, y: ay) { return 1 }
        }
        return 2
    }

    /// Step 5P (msg 160): tile-source access for the layer spike.
    /// The same createTile ladder walk paintCells performs (exact
    /// z = level-1, then ancestors z-1 and z-2 with coordinates
    /// halved per step), but returning the decoded image plus, for a
    /// substitute, the ancestor step (1 or 2) and the ancestor tile
    /// coordinates -- the inputs a CALayer contentsRect sub-quadrant
    /// needs. Decoding and caching are this view's own tileImage /
    /// NSCache path, unchanged. A nil image means missing at every
    /// step of the ladder.
    func layerTile(level: Int, tx: Int, ty: Int)
        -> (image: UIImage?, isSubstitute: Bool, step: Int, ax: Int, ay: Int) {
        if let img = tileImage(z: level - 1, x: tx, y: ty) {
            return (img, false, 0, tx, ty)
        }
        var az = level - 1, ax = tx, ay = ty
        for step in 1...2 {
            az -= 1; ax /= 2; ay /= 2
            if az < 0 { break }
            if let img = tileImage(z: az, x: ax, y: ay) {
                return (img, true, step, ax, ay)
            }
        }
        return (nil, false, 0, tx, ty)
    }

    /// The cell painter: every cell overlapped by rect (view-local
    /// coordinates; originGlobal maps view-local to global zoom-19
    /// px) resolved through the web createTile ladder and drawn at
    /// its footprint. Its only remaining caller is renderMiniMap
    /// (a synchronous pass in a pre-scaled context); the draw()
    /// override that once fed it to the CATiledLayer display was
    /// deleted in the step-7 cleanup. `count` gates the draw-call
    /// counter (the mini render passes false; the counter stays
    /// as the instruments' no-rasterization proof).
    func paintCells(in rect: CGRect, ctx: CGContext, count: Bool) {
        if count { countLock.lock(); drawCalls += 1; countLock.unlock() }
        let span = 256.0 * pow(2.0, Double(SpikeGeom.refZoom - level))
        let gx0 = Double(rect.minX) + Double(originGlobal.x)
        let gy0 = Double(rect.minY) + Double(originGlobal.y)
        let tx0 = Int(floor(gx0 / span))
        let ty0 = Int(floor(gy0 / span))
        let tx1 = Int(floor((gx0 + Double(rect.width) - 0.001) / span))
        let ty1 = Int(floor((gy0 + Double(rect.height) - 0.001) / span))
        if tx1 < tx0 || ty1 < ty0 { return }
        for ty in ty0...ty1 {
            for tx in tx0...tx1 {
                let foot = CGRect(
                    x: CGFloat(Double(tx) * span - Double(originGlobal.x)),
                    y: CGFloat(Double(ty) * span - Double(originGlobal.y)),
                    width: CGFloat(span), height: CGFloat(span))
                if let img = tileImage(z: level - 1, x: tx, y: ty) {
                    img.draw(in: foot)
                    countLock.lock(); drawnExact += 1; countLock.unlock()
                    continue
                }
                // Ancestor substitution (web createTile, msg 124 B):
                // same ladder — z-1, then z-2, coordinates halved per
                // step. The web layer stretches the whole ancestor over
                // the cell; the native view draws the ancestor's correct
                // sub-quadrant instead (same source tile, same ladder;
                // the quadrant is the geography this cell actually is).
                var painted = false
                var az = level - 1, ax = tx, ay = ty
                var aSpan = span
                for _ in 0..<2 {
                    az -= 1; ax /= 2; ay /= 2
                    aSpan *= 2.0
                    if az < 0 { break }
                    if let img = tileImage(z: az, x: ax, y: ay) {
                        let aFoot = CGRect(
                            x: CGFloat(Double(ax) * aSpan - Double(originGlobal.x)),
                            y: CGFloat(Double(ay) * aSpan - Double(originGlobal.y)),
                            width: CGFloat(aSpan), height: CGFloat(aSpan))
                        ctx.saveGState()
                        ctx.clip(to: foot)
                        img.draw(in: aFoot)
                        ctx.restoreGState()
                        painted = true
                        break
                    }
                }
                if !painted {
                    ctx.setFillColor(SpikeTiledView.beige.cgColor)
                    ctx.fill(foot)
                }
            }
        }
    }
}

// MARK: - Step-3 pins (Claude msg 154 dispatch: pins + chips + popups)
//
// Pin DATA arrives from the web, built by tpcpBuildNativePinData in
// app.html from the same sources and rules as the web map's own
// marker build (graph places/restrooms/services + TPCP_EXTRA_PINS,
// the shipped styles, the shipped popup fields). The native side
// owns only rendering and tap hit-testing; popup content is computed
// by the web and handed back via showPinPopup.

extension UIColor {
    convenience init(spikeHex hex: String) {
        var v = hex
        if v.hasPrefix("#") { v.removeFirst() }
        var rgb: UInt64 = 0
        Scanner(string: v).scanHexInt64(&rgb)
        self.init(red: CGFloat((rgb >> 16) & 0xFF) / 255.0,
                  green: CGFloat((rgb >> 8) & 0xFF) / 255.0,
                  blue: CGFloat(rgb & 0xFF) / 255.0, alpha: 1.0)
    }
}

struct SpikePin {
    let id: String
    let name: String
    let layer: String          // places | rr | svc | se | always
    let contentPoint: CGPoint  // zoom-19 px, tiled-view coordinate space
    let radius: CGFloat        // screen pt (Leaflet circleMarker radii
    let weight: CGFloat        // are zoom-independent screen units)
    let fill: UIColor
    let alpha: CGFloat
}

/// One acceptance-suite route (step 4): the web computed it with the
/// shipped router; native only draws it. points are content-space
/// (zoom-19 px relative to the tiled view's origin, like the pins);
/// coordFtNative is re-derived from the received lat/lons in Swift.
struct SpikeRoute {
    let id: String
    let label: String
    let points: [CGPoint]
    let nodesWeb: Int
    let distFt: Int
    let coordFtWeb: Int
    let coordFtNative: Int
}

/// Draws the layer-enabled pins at their current screen positions.
/// Lives ABOVE the scroll view (not inside the zoomed content) so the
/// circles keep their screen-point radii at every zoom, exactly like
/// Leaflet circleMarkers. Positions come from the view controller's
/// proven geometry: screen = content x zoomScale - contentOffset.
final class SpikePinOverlayView: UIView {
    var pins: [SpikePin] = []
    var screenPoint: (SpikePin) -> CGPoint = { _ in .zero }
    // Step 4: the current route as content-space points (empty = no
    // route shown), projected through the same transform as the pins
    // and drawn UNDER them.
    var routePoints: [CGPoint] = []
    var contentToScreen: (CGPoint) -> CGPoint = { $0 }
    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        if routePoints.count > 1 {
            // The web map's polyline, verbatim (tpcpComputeRoute):
            // white casing 9pt at 0.85 opacity, core #D43D2A 5pt,
            // round caps/joins; start dot r7 fill #1A6860, end dot
            // r7 fill #D43D2A, both white stroke 2.
            let pts = routePoints.map { contentToScreen($0) }
            func strokeRoute(_ width: CGFloat, _ color: UIColor) {
                let path = UIBezierPath()
                path.move(to: pts[0])
                for p in pts.dropFirst() { path.addLine(to: p) }
                path.lineWidth = width
                path.lineCapStyle = .round
                path.lineJoinStyle = .round
                color.setStroke()
                path.stroke()
            }
            strokeRoute(9, UIColor.white.withAlphaComponent(0.85))
            strokeRoute(5, UIColor(spikeHex: "#D43D2A"))
            for (pt, fill) in [(pts[0], UIColor(spikeHex: "#1A6860")),
                               (pts[pts.count - 1], UIColor(spikeHex: "#D43D2A"))] {
                let circle = CGRect(x: pt.x - 7, y: pt.y - 7, width: 14, height: 14)
                ctx.setFillColor(fill.cgColor)
                ctx.fillEllipse(in: circle)
                ctx.setStrokeColor(UIColor.white.cgColor)
                ctx.setLineWidth(2)
                ctx.strokeEllipse(in: circle.insetBy(dx: 1, dy: 1))
            }
        }
        for pin in pins {
            let c = screenPoint(pin)
            if c.x < -24 || c.y < -24 || c.x > rect.width + 24 || c.y > rect.height + 24 { continue }
            let r = pin.radius
            let circle = CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)
            ctx.setFillColor(pin.fill.withAlphaComponent(pin.alpha).cgColor)
            ctx.fillEllipse(in: circle)
            ctx.setStrokeColor(UIColor.white.cgColor)
            ctx.setLineWidth(pin.weight)
            ctx.strokeEllipse(in: circle.insetBy(dx: pin.weight / 2, dy: pin.weight / 2))
        }
    }
}

// MARK: - Spike view controller

final class SpikeViewController: UIViewController, UIScrollViewDelegate {
    private let scrollView = UIScrollView()
    private let tiledView = SpikeTiledView()
    // Step 6 (msg 162): the zoomed content -- a plain UIView with
    // NO draw(_:) override; the tiles are CALayer contents
    // composited into it (syncVisibleTiles). tiledView is no
    // longer displayed: it is the tile source (tileImage / NSCache
    // / resolution / layerTile), the role the micro-spike proved.
    private let contentView = UIView()
    private let diagLabel = UILabel()
    private let titleLabel = UILabel()
    private let doneButton = UIButton(type: .system)

    private var lastFitSize: CGSize = .zero
    /// Unzoomed content size (the MAXBOUNDS rect in zoom-19 px),
    /// captured in viewDidLoad before any zoom is applied. The fit
    /// math must use this, never scrollView.contentSize -- see
    /// centerOnResortBounds.
    private var contentUnits: CGSize = .zero
    private var userInteracted = false
    private var applyingFit = false
    // Step-2 fit trace (Claude msg 148: resolve the inset-geometry
    // discrepancy first). Records every layout size, every fit's
    // inputs and outputs, and every contentInset change (via KVO),
    // so one untouched open shows exactly which layout state the fit
    // consumed when it wrote the insets the device reports.
    private var fitTrace: [String] = []
    private var lastLayoutSize: CGSize = .zero
    private var lastTracedInset: UIEdgeInsets? = nil
    private var insetObservation: NSKeyValueObservation? = nil

    private func trace(_ s: String) {
        fitTrace.append(s)
        if fitTrace.count > 16 { fitTrace.removeFirst(fitTrace.count - 16) }
    }
    private(set) var fitZoom: Int = 0
    private var tilesStatus: String = "ok"
    private var packTileCount: Int = 0
    private var census: (inView: Int, exact: Int, substituted: Int, missing: Int, unpainted: Int) = (0, 0, 0, 0, 0)

    var onClose: (() -> Void)?

    // Step 3 state (see the pin types above). pins/initialLayers are
    // assigned by the plugin before presentation; empty pins = the
    // steps 1-2 bare view, unchanged.
    var pins: [SpikePin] = []
    var initialLayers: (places: Bool, svc: Bool, se: Bool) = (true, false, false)
    var onPinTap: ((String) -> Void)?
    var onPinDirections: ((String) -> Void)?
    private var showPlaces = true
    private var showSvc = false
    private var showSE = false
    private let pinOverlay = SpikePinOverlayView()
    private var chipButtons: [UIButton] = []
    // Step 7 (msg 164, item E): production chrome -- a designed
    // header block (solid white bar: navy Back pill + "Park Map"
    // title, mirroring the web map's .tpcp-map-head) with the
    // layer chips in a bar under it, replacing the floating
    // translucent pills on the production present only. The dev
    // entry (production == false) keeps its floating pills and
    // full-screen map exactly as before.
    private let headerBar = UIView()
    private let chipBar = UIView()
    private let chromeHairline = UIView()
    private let popupCard = UIView()
    private let popupName = UILabel()
    private let popupSub = UILabel()
    private let popupDirButton = UIButton(type: .system)
    private var popupPinId: String? = nil
    // Step 5 state: production presentation (set by the plugin from
    // the present call) and the settle-coalescing instrument.
    var production = false
    private var settlePending = false
    private var settleStartComposites = 0
    private(set) var lastSettleComposites = -1
    // Step 6 (msg 162): the layer tile engine's state on this, the
    // full surface -- the micro-spike's model promoted per the
    // ruling. Tile layers are composited into contentView, keyed
    // (level << 40) | (ty << 20) | tx exactly as the painted-cell
    // census keyed them; `level` is the VC's own now (the tile-
    // source instance's level no longer drives anything here).
    private var level: Int = 15
    private var tileLayers: [Int: CALayer] = [:]
    private var lastSyncSignature = ""
    private(set) var compositesTotal = 0
    private(set) var fitComposites = -1
    private var hasAppeared = false
    private var openStart: CFTimeInterval? = nil
    private(set) var openMs = -1
    // Step 10 (msg 168): first-open cold stamps (wall-clock
    // ms). tap/prep originate in JS (tapWallMs/prepWallMs on
    // the present call); call/parsed are stamped by the
    // plugin; didLoad/appear/painted in this controller.
    // Zero = not stamped, which suppresses the cold keys in
    // the snapshot entirely.
    var coldTapWall: Double = 0
    var coldPrepWall: Double = 0
    var coldCallWall: Double = 0
    var coldParsedWall: Double = 0
    private var coldDidLoadWall: Double = 0
    private var coldAppearWall: Double = 0
    private var coldPaintedWall: Double = 0
        // Step 4 state: the acceptance suite (assigned by the plugin
    // before presentation) and the route currently drawn.
    var routes: [SpikeRoute] = []
    private var currentRoute: SpikeRoute? = nil
    private let routesButton = UIButton(type: .system)
    private var lastTapName = ""
    private var lastPopupName = ""
    private var lastZoomEnd = Date.distantPast

    override func viewDidLoad() {
        super.viewDidLoad()
        // Step 7: in production the root view sits behind the
        // white chrome block, so it is white; the map's own ground
        // (#EFEDE7 -- the web map element's background, app.html
        // .tpcp-map-el) belongs to the scroll view and the content
        // view, which keep it in both modes.
        view.backgroundColor = production ? .white : SpikeTiledView.beige

        locateTiles()

        // Content = TPCP_RESORT_MAXBOUNDS in zoom-19 px (the web map's
        // own pan clamp, maxBoundsViscosity 1.0): the scroll view can
        // never leave it by more than the rubber-band bounce.
        let nw = SpikeGeom.globalPx(lat: SpikeGeom.maxNE.lat, lng: SpikeGeom.maxSW.lng)
        let se = SpikeGeom.globalPx(lat: SpikeGeom.maxSW.lat, lng: SpikeGeom.maxNE.lng)
        tiledView.originGlobal = nw
        contentView.frame = CGRect(x: 0, y: 0, width: se.x - nw.x, height: se.y - nw.y)
        contentView.backgroundColor = SpikeTiledView.beige
        contentUnits = contentView.frame.size

        scrollView.delegate = self
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.contentSize = contentView.frame.size
        trace(String(format: "LOAD cs %.0fx%.0f tiledFrame %.0fx%.0f",
                     scrollView.contentSize.width, scrollView.contentSize.height,
                     contentView.frame.width, contentView.frame.height))
        scrollView.backgroundColor = SpikeTiledView.beige
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.addSubview(contentView)
        view.addSubview(scrollView)
        // Step 7 chrome bars: added before the pin overlay, chips,
        // and popup so all of those stay above them; hidden unless
        // this is the production present.
        headerBar.backgroundColor = .white
        headerBar.isHidden = !production
        view.addSubview(headerBar)
        chipBar.backgroundColor = .white
        chipBar.isHidden = !production
        view.addSubview(chipBar)
        chromeHairline.backgroundColor = UIColor(spikeHex: "#E7E1D0")
        chromeHairline.isHidden = !production
        view.addSubview(chromeHairline)
        insetObservation = scrollView.observe(\.contentInset, options: [.new]) { [weak self] sv, change in
            guard let self = self, let nv = change.newValue else { return }
            if let last = self.lastTracedInset, last == nv { return }
            self.lastTracedInset = nv
            self.trace(String(format: "INSET -> t%.0f l%.0f b%.0f r%.0f",
                              nv.top, nv.left, nv.bottom, nv.right))
            _ = sv
        }

        titleLabel.text = production ? "Park Map" : "Native map spike (dev)"
        titleLabel.font = UIFont.boldSystemFont(ofSize: 13)
        titleLabel.textColor = .white
        titleLabel.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        titleLabel.textAlignment = .center
        titleLabel.layer.cornerRadius = 6
        titleLabel.layer.masksToBounds = true
        view.addSubview(titleLabel)

        doneButton.setTitle(production ? "Back" : "Done", for: .normal)
        doneButton.titleLabel?.font = UIFont.boldSystemFont(ofSize: 14)
        doneButton.setTitleColor(.white, for: .normal)
        doneButton.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        doneButton.layer.cornerRadius = 6
        doneButton.contentEdgeInsets = UIEdgeInsets(top: 6, left: 14, bottom: 6, right: 14)
        doneButton.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
        view.addSubview(doneButton)

        if production {
            // Step 7: the web map's header treatment with its own
            // values (.tpcp-map-back / .tpcp-map-title in
            // app.html): Back is a navy #173A5E capsule, 36 pt
            // tall, 14 pt side padding, label with arrow; the
            // title is #173A5E at 16 pt, weight 800, left-aligned
            // beside it on the white bar. (Bold system font
            // stands in for Outfit, as everywhere in this file.)
            titleLabel.font = UIFont.boldSystemFont(ofSize: 16)
            titleLabel.textColor = UIColor(spikeHex: "#173A5E")
            titleLabel.backgroundColor = .clear
            titleLabel.textAlignment = .left
            titleLabel.layer.cornerRadius = 0
            doneButton.setTitle("← Back", for: .normal)
            doneButton.backgroundColor = UIColor(spikeHex: "#173A5E")
            doneButton.layer.cornerRadius = 18
            doneButton.contentEdgeInsets = UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 14)
        }

        diagLabel.font = UIFont.monospacedSystemFont(ofSize: 10, weight: .regular)
        diagLabel.textColor = .white
        diagLabel.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        diagLabel.numberOfLines = 0
        diagLabel.layer.cornerRadius = 6
        diagLabel.layer.masksToBounds = true
        diagLabel.isHidden = production
        view.addSubview(diagLabel)

        // Step 3 UI (hidden/inert when no pin data was passed).
        pinOverlay.backgroundColor = .clear
        pinOverlay.isUserInteractionEnabled = false
        pinOverlay.screenPoint = { [weak self] pin in
            self?.pinScreenPoint(pin) ?? .zero
        }
        pinOverlay.contentToScreen = { [weak self] p in
            self?.contentPointToScreen(p) ?? .zero
        }
        view.addSubview(pinOverlay)

        // Step 4 harness chrome: the Routes suite picker (hidden
        // when no route data was passed).
        routesButton.setTitle("Routes", for: .normal)
        routesButton.titleLabel?.font = UIFont.boldSystemFont(ofSize: 14)
        routesButton.setTitleColor(.white, for: .normal)
        routesButton.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        routesButton.layer.cornerRadius = 6
        routesButton.contentEdgeInsets = UIEdgeInsets(top: 6, left: 14, bottom: 6, right: 14)
        routesButton.addTarget(self, action: #selector(routesTapped), for: .touchUpInside)
        view.addSubview(routesButton)

        for (i, t) in ["Rides & Food", "Services", "Shops & Entertainment"].enumerated() {
            let b = UIButton(type: .system)
            b.setTitle(t, for: .normal)
            b.titleLabel?.font = UIFont.boldSystemFont(ofSize: 12)
            b.layer.cornerRadius = 13
            b.contentEdgeInsets = UIEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
            b.tag = i
            b.addTarget(self, action: #selector(chipTapped(_:)), for: .touchUpInside)
            if production {
                // On the white chip bar, the off state's white
                // fill needs the header hairline as its edge (the
                // web chip floats over tiles and carries a shadow
                // instead; on a bar the border is the designed
                // equivalent). State colors stay applyLayerState's.
                b.layer.borderWidth = 1
                b.layer.borderColor = UIColor(spikeHex: "#E7E1D0").cgColor
            }
            chipButtons.append(b)
            view.addSubview(b)
        }

        // Popup card: a pixel-faithful rendering of the web's
        // .tpcp-pop (white card, #173A5E name, #5A7263 sub, #1A6860
        // Directions). The CONTENT (name/sub/Directions eligibility)
        // is computed by the web and arrives via showPinPopup; this
        // card is the spike harness's display surface for it.
        popupCard.backgroundColor = .white
        popupCard.layer.cornerRadius = 12
        popupCard.layer.shadowColor = UIColor.black.cgColor
        popupCard.layer.shadowOpacity = 0.25
        popupCard.layer.shadowRadius = 10
        popupCard.layer.shadowOffset = CGSize(width: 0, height: 3)
        popupCard.isHidden = true
        view.addSubview(popupCard)
        popupName.font = UIFont.boldSystemFont(ofSize: 14)
        popupName.textColor = UIColor(spikeHex: "#173A5E")
        popupName.numberOfLines = 0
        popupCard.addSubview(popupName)
        popupSub.font = UIFont.systemFont(ofSize: 11.5)
        popupSub.textColor = UIColor(spikeHex: "#5A7263")
        popupSub.numberOfLines = 0
        popupCard.addSubview(popupSub)
        popupDirButton.setTitle("Directions", for: .normal)
        popupDirButton.titleLabel?.font = UIFont.boldSystemFont(ofSize: 13)
        popupDirButton.setTitleColor(.white, for: .normal)
        popupDirButton.backgroundColor = UIColor(spikeHex: "#1A6860")
        popupDirButton.layer.cornerRadius = 8
        popupDirButton.addTarget(self, action: #selector(popupDirectionsTapped), for: .touchUpInside)
        popupCard.addSubview(popupDirButton)

        let tap = UITapGestureRecognizer(target: self, action: #selector(mapTapped(_:)))
        tap.numberOfTouchesRequired = 1
        tap.cancelsTouchesInView = false
        scrollView.addGestureRecognizer(tap)

        showPlaces = initialLayers.places
        showSvc = initialLayers.svc
        showSE = initialLayers.se
        applyLayerState()
        coldDidLoadWall = spikeWallMsNow()
    }

    private func locateTiles() {
        // Primary lookup: the folder-reference name in the bundle's
        // resources. Fallback: the resource URL path directly (same
        // location, in case the by-name lookup misses the folder).
        var tilesURL = Bundle.main.url(forResource: "tiles", withExtension: nil)
        if tilesURL == nil, let res = Bundle.main.resourceURL {
            let candidate = res.appendingPathComponent("tiles")
            if FileManager.default.fileExists(atPath: candidate.path) {
                tilesURL = candidate
            }
        }
        guard let tilesURL = tilesURL else {
            tilesStatus = "tiles folder MISSING from app bundle (Xcode Add Files step not done)"
            return
        }
        let resort = tilesURL.appendingPathComponent("resort")
        if FileManager.default.fileExists(atPath: resort.path) {
            tiledView.tilesRoot = resort
        } else {
            tilesStatus = "tiles/resort MISSING from app bundle"
            return
        }
        let manifest = tilesURL.appendingPathComponent("manifest.json")
        if let data = try? Data(contentsOf: manifest),
           let obj = try? JSONSerialization.jsonObject(with: data),
           let dict = obj as? [String: Any],
           let n = dict["keyCount"] as? Int {
            packTileCount = n
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        coldAppearWall = spikeWallMsNow()
        super.viewDidAppear(animated)
        trace(String(format: "APPEAR cs %.0fx%.0f in t%.0f l%.0f off (%.0f,%.0f) sv %.0fx%.0f",
                     scrollView.contentSize.width, scrollView.contentSize.height,
                     scrollView.contentInset.top, scrollView.contentInset.left,
                     scrollView.contentOffset.x, scrollView.contentOffset.y,
                     scrollView.bounds.width, scrollView.bounds.height))
        // Step 6 (msg 162): the open-to-painted clock starts here,
        // with the view on screen at its final bounds and the fit
        // already applied -- it measures the rendering surface
        // (tiles + pins + chrome), not the modal presentation or
        // the bridge (design section 4).
        hasAppeared = true
        if openStart == nil { openStart = CACurrentMediaTime() }
        performOpenSyncIfNeeded()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Step 7: production frames the map under the chrome
        // block (header bar + chip bar + the hairline under
        // them); the dev entry keeps the full-screen map.
        let chromeTop = chromeMapTop()
        if production {
            let headH = view.safeAreaInsets.top + 60
            headerBar.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: headH)
            chipBar.frame = CGRect(x: 0, y: headH, width: view.bounds.width, height: 46)
            chromeHairline.frame = CGRect(x: 0, y: chromeTop - 1, width: view.bounds.width, height: 1)
            scrollView.frame = CGRect(x: 0, y: chromeTop, width: view.bounds.width,
                                      height: view.bounds.height - chromeTop)
        } else {
            scrollView.frame = view.bounds
        }
        if scrollView.bounds.size != lastLayoutSize {
            lastLayoutSize = scrollView.bounds.size
            trace(String(format: "LAYOUT sv %.0fx%.0f view %.0fx%.0f inter %d",
                         scrollView.bounds.width, scrollView.bounds.height,
                         view.bounds.width, view.bounds.height,
                         userInteracted ? 1 : 0))
        }
        let safe = view.safeAreaInsets
        if production {
            // The web head's row: 14 pt side padding, starts 12 pt
            // below the safe area, 36 pt tall; Back pill first,
            // title beside it (flex:1 in the web row).
            let db = doneButton.intrinsicContentSize
            doneButton.frame = CGRect(x: 14, y: safe.top + 12, width: db.width, height: 36)
            titleLabel.frame = CGRect(x: 14 + db.width + 8, y: safe.top + 12,
                                      width: view.bounds.width - 14 - db.width - 8 - 14,
                                      height: 36)
        } else {
            titleLabel.frame = CGRect(x: safe.left + 10, y: safe.top + 8, width: 168, height: 24)
            let db = doneButton.intrinsicContentSize
            doneButton.frame = CGRect(x: view.bounds.width - safe.right - db.width - 10,
                                      y: safe.top + 8, width: db.width, height: 24)
        }
        let diagH: CGFloat = pins.isEmpty ? 84 : 116
        diagLabel.frame = CGRect(x: safe.left + 10,
                                 y: view.bounds.height - safe.bottom - diagH - 8,
                                 width: view.bounds.width - safe.left - safe.right - 20,
                                 height: diagH)
        // The overlay's projection is scroll-view space
        // (contentPointToScreen), so the overlay takes the scroll
        // view's frame exactly -- view.bounds on the dev entry,
        // the framed viewport in production.
        pinOverlay.frame = scrollView.frame
        let rb = routesButton.intrinsicContentSize
        routesButton.frame = CGRect(x: safe.left + 10, y: safe.top + 74, width: rb.width, height: 24)
        routesButton.isHidden = production || routes.isEmpty
        if !chipButtons.isEmpty {
            for b in chipButtons { b.isHidden = pins.isEmpty }
            if !pins.isEmpty {
                if production {
                    // In the chip bar: 14 pt left padding (the web
                    // head's), chips 10 pt below the bar's top.
                    var x: CGFloat = 14
                    for b in chipButtons {
                        let w = b.intrinsicContentSize.width + 4
                        b.frame = CGRect(x: x, y: chromeTop - 46 + 10, width: w, height: 26)
                        x += w + 8
                    }
                } else {
                    var x = safe.left + 10
                    for b in chipButtons {
                        let w = b.intrinsicContentSize.width + 4
                        b.frame = CGRect(x: x, y: safe.top + 40, width: w, height: 26)
                        x += w + 8
                    }
                }
            }
        }
        if !popupCard.isHidden { layoutPopupCard() }
        // The first layout pass can run at a transient size during the
        // modal presentation; the 982e06a build latched its fit there
        // and opened mis-framed. Re-fit whenever the size changes until
        // the user takes over the map.
        if !userInteracted && scrollView.bounds.size != lastFitSize
            && scrollView.bounds.width > 0 && scrollView.bounds.height > 0 {
            lastFitSize = scrollView.bounds.size
            applyFit()
        }
    }

    private func applyFit() {
        let size = scrollView.bounds.size
        let csStart = scrollView.contentSize
        fitZoom = SpikeGeom.leafletFitZoom(viewport: size)
        scrollView.minimumZoomScale = CGFloat(pow(2.0, Double(SpikeGeom.minMapZoom - SpikeGeom.refZoom)))
        scrollView.maximumZoomScale = 1.0
        level = fitZoom
        let scale = CGFloat(pow(2.0, Double(fitZoom - SpikeGeom.refZoom)))
        applyingFit = true
        scrollView.zoomScale = scale
        applyingFit = false
        centerOnResortBounds(scale: scale)
        trace(String(format: "FIT vp %.0fx%.0f fz %d sc %.4f csStart %.0fx%.0f cs %.0fx%.0f -> in t%.0f l%.0f off (%.0f,%.0f)",
                     size.width, size.height, fitZoom, Double(scale),
                     csStart.width, csStart.height,
                     scrollView.contentSize.width, scrollView.contentSize.height,
                     scrollView.contentInset.top, scrollView.contentInset.left,
                     scrollView.contentOffset.x, scrollView.contentOffset.y))
        refreshDiagnostics()
        if hasAppeared { performOpenSyncIfNeeded() }
        // Re-read once the first composite has landed so the census
        // reflects the settled first paint (with compositing the
        // sync is synchronous; the re-read now just confirms it).
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.refreshDiagnostics()
        }
    }

    /// Step 7: the production chrome block's height -- the header
    /// bar (safe-area top + the web head's 12 + 36 + 12) plus the
    /// 46 pt chip bar (26 pt chips with 10 pt padding). The map
    /// viewport starts at this y in production; 0 on the dev entry.
    private func chromeMapTop() -> CGFloat {
        return production ? view.safeAreaInsets.top + 60 + 46 : 0
    }

    private func centerOnResortBounds(scale: CGFloat) {
        let cLat = (SpikeGeom.boundsSW.lat + SpikeGeom.boundsNE.lat) / 2.0
        let cLng = (SpikeGeom.boundsSW.lng + SpikeGeom.boundsNE.lng) / 2.0
        let c = SpikeGeom.globalPx(lat: cLat, lng: cLng)
        let localX = Double(c.x - tiledView.originGlobal.x)
        let localY = Double(c.y - tiledView.originGlobal.y)
        let vp = scrollView.bounds.size
        // Displayed content size = unzoomed size x scale, from the
        // stored contentUnits. Do NOT read scrollView.contentSize
        // here: assigning zoomScale (in applyFit, just before this
        // call) makes UIScrollView rewrite contentSize to the ZOOMED
        // size (6785x7897 -> 424x494 at the fit scale) -- the step-2
        // fit trace (build 61811dc) caught exactly that between
        // applyFit's entry (csStart 6785x7897) and this read (cs
        // 424x494). The original code multiplied the rewritten value
        // by scale a second time, computed a 26x30 pt content, and
        // produced the corner-clamped insets (t422 l188) and offset
        // (-188,-422) present since the spike's first build.
        let cw = Double(contentUnits.width) * Double(scale)
        let ch = Double(contentUnits.height) * Double(scale)
        // When the clamped content is smaller than the viewport on an
        // axis, center it with insets (fitBounds centers the same way).
        let ix = max(0.0, (Double(vp.width) - cw) / 2.0)
        let iy = max(0.0, (Double(vp.height) - ch) / 2.0)
        scrollView.contentInset = UIEdgeInsets(top: CGFloat(iy), left: CGFloat(ix),
                                               bottom: CGFloat(iy), right: CGFloat(ix))
        var ox = localX * Double(scale) - Double(vp.width) / 2.0
        var oy = localY * Double(scale) - Double(vp.height) / 2.0
        ox = min(max(ox, -ix), cw - Double(vp.width) + ix)
        oy = min(max(oy, -iy), ch - Double(vp.height) + iy)
        scrollView.contentOffset = CGPoint(x: ox, y: oy)
    }

    // MARK: UIScrollViewDelegate

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        userInteracted = true
    }

    func scrollViewWillBeginZooming(_ scrollView: UIScrollView, with view: UIView?) {
        userInteracted = true
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? {
        return contentView
    }
    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        if !applyingFit { userInteracted = true }
        let z = 19.0 + log2(Double(scrollView.zoomScale))
        let l = Int(min(Double(SpikeGeom.maxMapZoom),
                        max(Double(SpikeGeom.minMapZoom), z.rounded())))
        if l != level {
            level = l
            if hasAppeared { syncVisibleTiles(); refreshDiagnostics() }
        }
        pinOverlay.setNeedsDisplay()
    }
    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if hasAppeared { syncVisibleTiles() }
        pinOverlay.setNeedsDisplay()
    }
    // Step 6 (msg 162): the settle measurement from the layer
    // spike, replacing step 5's settle repaint + settle-draws
    // instrument. Same end-hooks and 60 ms coalescing window
    // (drag-end, deceleration-end, and zoom-end can all fire for a
    // single flick; the first arms the window and the rest fold
    // into it), but the value is assigned SYNCHRONOUSLY after the
    // settle sync -- layer contents assignments have no
    // asynchronous paint tail, so the number is final in the same
    // turn and cannot be stranded by a quick Done.
    private func settleCompositeSync() {
        pinOverlay.setNeedsDisplay()
        refreshDiagnostics()
        if settlePending { return }
        settlePending = true
        settleStartComposites = compositesTotal
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { [weak self] in
            guard let self = self else { return }
            self.settlePending = false
            self.syncVisibleTiles()
            self.lastSettleComposites = self.compositesTotal - self.settleStartComposites
            self.pinOverlay.setNeedsDisplay()
            self.refreshDiagnostics()
        }
    }
    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
        lastZoomEnd = Date()
        settleCompositeSync()
    }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { settleCompositeSync() }
    }
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        settleCompositeSync()
    }

    // MARK: step 4 — route suite picker, camera fit

    @objc private func routesTapped() {
        let ac = UIAlertController(title: "Routes (step 4 suite)",
                                   message: currentRoute.map { "Showing: \($0.label)" },
                                   preferredStyle: .actionSheet)
        for r in routes {
            ac.addAction(UIAlertAction(title: "\(r.label) · \(r.distFt) ft", style: .default) { [weak self] _ in
                self?.showRoute(r)
            })
        }
        if currentRoute != nil {
            ac.addAction(UIAlertAction(title: "Clear route", style: .destructive) { [weak self] _ in
                self?.clearRoute()
            })
        }
        ac.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        ac.popoverPresentationController?.sourceView = routesButton
        present(ac, animated: true)
    }

    private func showRoute(_ r: SpikeRoute) {
        currentRoute = r
        pinOverlay.routePoints = r.points
        pinOverlay.setNeedsDisplay()
        fitRoute(r)
        refreshDiagnostics()
    }

    private func clearRoute() {
        currentRoute = nil
        pinOverlay.routePoints = []
        pinOverlay.setNeedsDisplay()
        refreshDiagnostics()
    }

    /// Leaflet fitBounds(bounds, padding 24) analog for the route:
    /// the largest clamped scale that fits the route's bbox with
    /// 24pt padding, centered on the bbox.
    private func fitRoute(_ r: SpikeRoute) {
        guard let first = r.points.first else { return }
        var b = CGRect(x: first.x, y: first.y, width: 0, height: 0)
        for p in r.points { b = b.union(CGRect(x: p.x, y: p.y, width: 0, height: 0)) }
        let vp = scrollView.bounds.size
        guard vp.width > 0, vp.height > 0 else { return }
        let pad: CGFloat = 24
        let bw = max(b.width, 1), bh = max(b.height, 1)
        var scale = min((vp.width - pad * 2) / bw, (vp.height - pad * 2) / bh)
        scale = min(max(scale, scrollView.minimumZoomScale), scrollView.maximumZoomScale)
        applyingFit = true
        scrollView.setZoomScale(scale, animated: false)
        let ox = b.midX * scale - vp.width / 2
        let oy = b.midY * scale - vp.height / 2
        scrollView.setContentOffset(CGPoint(x: ox, y: oy), animated: false)
        applyingFit = false
        // The route fit owns the camera now; the open-fit must not
        // stomp it on a later layout pass.
        userInteracted = true
        pinOverlay.setNeedsDisplay()
    }

    // MARK: step 3 — layers, hit-testing, popup card

    private func layerShown(_ layer: String) -> Bool {
        switch layer {
        case "places": return showPlaces
        case "rr", "svc": return showSvc   // restrooms ride Services,
        case "se": return showSE           // as on the web map
        default: return true               // "always": behind no toggle
        }
    }

    private func classCount(_ layer: String) -> Int {
        return pins.filter { $0.layer == layer }.count
    }

    private func visiblePinCount() -> Int {
        return pins.filter { layerShown($0.layer) }.count
    }

    private func applyLayerState() {
        let navy = UIColor(spikeHex: "#173A5E")
        for (i, b) in chipButtons.enumerated() {
            let on = i == 0 ? showPlaces : (i == 1 ? showSvc : showSE)
            b.backgroundColor = on ? navy : UIColor.white.withAlphaComponent(0.94)
            b.setTitleColor(on ? .white : navy, for: .normal)
        }
        pinOverlay.pins = pins.filter { layerShown($0.layer) }
        pinOverlay.setNeedsDisplay()
    }

    @objc private func chipTapped(_ b: UIButton) {
        if b.tag == 0 { showPlaces.toggle() }
        if b.tag == 1 { showSvc.toggle() }
        if b.tag == 2 { showSE.toggle() }
        applyLayerState()
        refreshDiagnostics()
    }

    /// The same state change, driven from JS (the end-state chips are
    /// web DOM calling this through the plugin; the harness's native
    /// chip row calls the identical path via chipTapped).
    func setLayers(places: Bool, svc: Bool, se: Bool) {
        showPlaces = places
        showSvc = svc
        showSE = se
        applyLayerState()
        refreshDiagnostics()
    }

    private func pinScreenPoint(_ pin: SpikePin) -> CGPoint {
        return contentPointToScreen(pin.contentPoint)
    }

    private func contentPointToScreen(_ p: CGPoint) -> CGPoint {
        let s = scrollView.zoomScale
        let off = scrollView.contentOffset
        return CGPoint(x: p.x * s - off.x, y: p.y * s - off.y)
    }

    @objc private func mapTapped(_ gr: UITapGestureRecognizer) {
        guard !pins.isEmpty else { return }
        // A pinch's trailing touch can read as a tap; ignore taps
        // that land immediately after a zoom settles.
        if Date().timeIntervalSince(lastZoomEnd) < 0.25 { return }
        // Hit-testing compares against pinScreenPoint, which is
        // pin-overlay space: the overlay's frame is the scroll
        // view's frame and its bounds origin is zero, in both the
        // framed and full-screen entries. (Step 7 compared in
        // scroll-view space -- bounds space, whose origin is the
        // contentOffset -- shifting every test by the offset and
        // killing pin taps; diagnosed + fixed per msg 170.)
        let loc = gr.location(in: pinOverlay)
        var best: SpikePin? = nil
        var bestD = Double.greatestFiniteMagnitude
        for pin in pins where layerShown(pin.layer) {
            let sp = pinScreenPoint(pin)
            let d = hypot(Double(loc.x - sp.x), Double(loc.y - sp.y))
            if d <= Double(pin.radius) + 8.0 && d < bestD {
                bestD = d
                best = pin
            }
        }
        if let pin = best {
            lastTapName = pin.name
            hidePopupCard()
            refreshDiagnostics()
            onPinTap?(pin.id)
        } else {
            hidePopupCard()
        }
    }

    /// Popup content arrives from the web (the popup's owner): this
    /// only displays it, anchored above the tapped pin like the
    /// Leaflet popup it mirrors.
    func showPinPopup(name: String, sub: String, hasDir: Bool, pinId: String) {
        guard pins.first(where: { $0.id == pinId }) != nil else { return }
        popupPinId = pinId
        lastPopupName = name
        popupName.text = name
        popupSub.text = sub
        popupSub.isHidden = sub.isEmpty
        popupDirButton.isHidden = !hasDir
        popupCard.isHidden = false
        layoutPopupCard()
        refreshDiagnostics()
    }

    private func layoutPopupCard() {
        guard let id = popupPinId,
              let pin = pins.first(where: { $0.id == id }) else { return }
        let w: CGFloat = 216
        let pad: CGFloat = 14
        let innerW = w - pad * 2
        let nameH = ceil(popupName.sizeThatFits(
            CGSize(width: innerW, height: .greatestFiniteMagnitude)).height)
        let subH = popupSub.isHidden ? 0 : ceil(popupSub.sizeThatFits(
            CGSize(width: innerW, height: .greatestFiniteMagnitude)).height)
        let dirH: CGFloat = popupDirButton.isHidden ? 0 : 33
        var h = pad + nameH
        if subH > 0 { h += 4 + subH }
        if dirH > 0 { h += 10 + dirH }
        h += pad
        let sp = pinScreenPoint(pin)
        // The card is framed in view coordinates; the pin's
        // screen point is scroll-view space. The two differ only
        // by the scroll view's y origin -- the chrome block's
        // height in production, 0 on the dev entry.
        let yOff = scrollView.frame.minY
        let x = min(max(sp.x - w / 2, 10), view.bounds.width - w - 10)
        var y = sp.y + yOff - h - pin.radius - 10
        let topLimit = production ? yOff + 10 : view.safeAreaInsets.top + 74
        if y < topLimit { y = sp.y + yOff + pin.radius + 10 }
        popupCard.frame = CGRect(x: x, y: y, width: w, height: h)
        var cy = pad
        popupName.frame = CGRect(x: pad, y: cy, width: innerW, height: nameH)
        cy += nameH
        if subH > 0 {
            cy += 4
            popupSub.frame = CGRect(x: pad, y: cy, width: innerW, height: subH)
            cy += subH
        }
        if dirH > 0 {
            cy += 10
            popupDirButton.frame = CGRect(x: pad, y: cy, width: innerW, height: dirH)
        }
    }

    private func hidePopupCard() {
        popupCard.isHidden = true
        popupPinId = nil
    }

    @objc private func popupDirectionsTapped() {
        if let id = popupPinId { onPinDirections?(id) }
        hidePopupCard()
    }

    // MARK: step 6 -- layer tile engine (msg 162)

    /// The visible cell range at the current level, computed with
    /// the census math from refreshDiagnostics. Sync and census
    /// share this one function (they cannot drift).
    private func visibleCellRange() -> (tx0: Int, ty0: Int, tx1: Int, ty1: Int, span: Double)? {
        let s = Double(scrollView.zoomScale)
        guard s > 0 else { return nil }
        var vis = CGRect(x: Double(scrollView.contentOffset.x) / s,
                         y: Double(scrollView.contentOffset.y) / s,
                         width: Double(scrollView.bounds.width) / s,
                         height: Double(scrollView.bounds.height) / s)
        vis = vis.intersection(contentView.bounds)
        if vis.isNull || vis.isEmpty { return nil }
        let span = 256.0 * pow(2.0, Double(SpikeGeom.refZoom - level))
        let gx0 = vis.minX + Double(tiledView.originGlobal.x)
        let gy0 = vis.minY + Double(tiledView.originGlobal.y)
        let tx0 = Int(floor(gx0 / span))
        let ty0 = Int(floor(gy0 / span))
        let tx1 = Int(floor((gx0 + Double(vis.width) - 0.001) / span))
        let ty1 = Int(floor((gy0 + Double(vis.height) - 0.001) / span))
        if tx1 < tx0 || ty1 < ty0 { return nil }
        return (tx0, ty0, tx1, ty1, span)
    }

    /// Reconcile the tile layers with the visible set: create a
    /// layer for each newly visible resolvable cell (ONE contents
    /// assignment = ONE composite), prune layers that left the set.
    /// The pack is static, so an unchanged (level, range) signature
    /// makes the call a no-op -- most pan ticks cost one range
    /// computation and one comparison.
    private func syncVisibleTiles() {
        guard let r = visibleCellRange() else { return }
        let signature = "\(level)/\(r.tx0)/\(r.ty0)/\(r.tx1)/\(r.ty1)"
        if signature == lastSyncSignature { return }
        lastSyncSignature = signature
        var desired = Set<Int>()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for ty in r.ty0...r.ty1 {
            for tx in r.tx0...r.tx1 {
                let key = (level << 40) | (ty << 20) | tx
                let t = tiledView.layerTile(level: level, tx: tx, ty: ty)
                guard let img = t.image else { continue }
                desired.insert(key)
                if tileLayers[key] != nil { continue }
                let layer = CALayer()
                layer.frame = CGRect(
                    x: CGFloat(Double(tx) * r.span - Double(tiledView.originGlobal.x)),
                    y: CGFloat(Double(ty) * r.span - Double(tiledView.originGlobal.y)),
                    width: CGFloat(r.span), height: CGFloat(r.span))
                if t.isSubstitute {
                    // The ancestor's sub-quadrant for this cell:
                    // same source image, same geographic sub-region
                    // paintCells clips to.
                    let n = 1 << t.step
                    let qx = tx - t.ax * n
                    let qy = ty - t.ay * n
                    layer.contentsRect = CGRect(x: CGFloat(qx) / CGFloat(n),
                                                y: CGFloat(qy) / CGFloat(n),
                                                width: 1.0 / CGFloat(n),
                                                height: 1.0 / CGFloat(n))
                }
                layer.contents = img.cgImage
                compositesTotal += 1
                contentView.layer.addSublayer(layer)
                tileLayers[key] = layer
            }
        }
        let stale = tileLayers.keys.filter { !desired.contains($0) }
        for key in stale {
            tileLayers[key]?.removeFromSuperlayer()
            tileLayers.removeValue(forKey: key)
        }
        CATransaction.commit()
    }

    /// The first sync after appear runs inside an explicit
    /// transaction whose completion block timestamps the moment the
    /// render server presents the frame carrying the last tile
    /// contents -- the open-to-fully-painted measurement (design
    /// section 4). The pin overlay's first display is requested
    /// inside the same transaction: its draw is main-thread
    /// synchronous work performed during the commit, so the
    /// presented frame the completion block timestamps carries the
    /// tiles AND the pins/chrome above them (msg 162 carry-in 3).
    /// Later calls are plain syncs.
    private func performOpenSyncIfNeeded() {
        if openMs >= 0 { syncVisibleTiles(); return }
        if openStart == nil { openStart = CACurrentMediaTime() }
        let start = openStart ?? CACurrentMediaTime()
        let before = compositesTotal
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            guard let self = self else { return }
            if self.openMs < 0 {
                self.openMs = Int(((CACurrentMediaTime() - start) * 1000.0).rounded())
                self.coldPaintedWall = spikeWallMsNow()
            }
            self.refreshDiagnostics()
        }
        syncVisibleTiles()
        pinOverlay.setNeedsDisplay()
        CATransaction.commit()
        if fitComposites < 0 { fitComposites = compositesTotal - before }
    }

    // MARK: diagnostics (msg 142: in-process readout, from the start)

    private func refreshDiagnostics() {
        let s = Double(scrollView.zoomScale)
        guard s > 0 else { return }
        var vis = CGRect(x: Double(scrollView.contentOffset.x) / s,
                         y: Double(scrollView.contentOffset.y) / s,
                         width: Double(scrollView.bounds.width) / s,
                         height: Double(scrollView.bounds.height) / s)
        vis = vis.intersection(contentView.bounds)
        var inView = 0, exact = 0, subst = 0, missing = 0, unpainted = 0
        if !vis.isNull && !vis.isEmpty {
            let span = 256.0 * pow(2.0, Double(SpikeGeom.refZoom - level))
            let gx0 = vis.minX + Double(tiledView.originGlobal.x)
            let gy0 = vis.minY + Double(tiledView.originGlobal.y)
            let tx0 = Int(floor(gx0 / span))
            let ty0 = Int(floor(gy0 / span))
            let tx1 = Int(floor((gx0 + Double(vis.width) - 0.001) / span))
            let ty1 = Int(floor((gy0 + Double(vis.height) - 0.001) / span))
            if tx1 >= tx0 && ty1 >= ty0 {
                for ty in ty0...ty1 {
                    for tx in tx0...tx1 {
                        inView += 1
                        let res = tiledView.resolution(z: level - 1, x: tx, y: ty)
                        switch res {
                        case 0: exact += 1
                        case 1: subst += 1
                        default: missing += 1
                        }
                        if res != 2 && tileLayers[(level << 40) | (ty << 20) | tx] == nil {
                            unpainted += 1
                        }
                    }
                }
            }
        }
        census = (inView, exact, subst, missing, unpainted)
        let zoomNow = 19.0 + log2(s)
        let bo = scrollView.bounds.size
        let of = scrollView.contentOffset
        let ci = scrollView.contentInset
        diagLabel.text = String(
            format: " fit zoom %d · zoom %.2f · layers %d · engine layer\n tiles in view %d — exact %d · substituted %d · missing %d · unpainted %d\n pack %@ · %@\n sv %.0fx%.0f · off (%.0f,%.0f) · inset t%.0f l%.0f b%.0f r%.0f",
            fitZoom, zoomNow, tileLayers.count,
            inView, exact, subst, missing, unpainted,
            packTileCount > 0 ? "\(packTileCount) tiles" : "size unknown",
            tilesStatus,
            bo.width, bo.height, of.x, of.y, ci.top, ci.left, ci.bottom, ci.right)
        diagLabel.text = (diagLabel.text ?? "") + String(
            format: "\n open %d ms · fit comp %d · comp %d · settle comp %d · tile draws %d",
            openMs, fitComposites, compositesTotal, lastSettleComposites, tiledView.drawCalls)
        if let last = fitTrace.last {
            diagLabel.text = (diagLabel.text ?? "") + "\n " + last
        }
        if !pins.isEmpty {
            diagLabel.text = (diagLabel.text ?? "") + String(
                format: "\n pins %d/%d shown · places %d rr %d svc %d se %d always %d · tap %@",
                visiblePinCount(), pins.count,
                classCount("places"), classCount("rr"), classCount("svc"),
                classCount("se"), classCount("always"),
                lastTapName.isEmpty ? "-" : lastTapName)
        }
        if let r = currentRoute {
            diagLabel.text = (diagLabel.text ?? "") + String(
                format: "\n route %@ · %d nodes · %d ft · coordFt web %d / native %d",
                r.label, r.points.count, r.distFt, r.coordFtWeb, r.coordFtNative)
        }
    }

    /// Step-2 item 3, device half: for each parity-table viewport,
    /// evaluate the shipped fit (SpikeGeom.leafletFitZoom, plus the
    /// inset/offset arithmetic mirrored from centerOnResortBounds)
    /// and the census's cell-range math (mirrored from
    /// refreshDiagnostics) -- without touching the live scroll view.
    /// Keep the mirrored lines in step with their originals. Built-in
    /// cross-check: the row for the device's own viewport must equal
    /// the same open's live overlay readings.
    private func paritySweep() -> [String] {
        var sizes: [(Double, Double)] = [(402, 874), (402, 751), (430, 932), (390, 844),
                                         (375, 667), (320, 568), (768, 1024), (820, 1180)]
        // Step 7: the production viewport (the framed area under
        // the chrome block) is none of the tabulated screen sizes,
        // so the sweep's built-in cross-check -- the row for the
        // viewport in use equals the same open's live readings --
        // would silently stop covering the production open.
        // Prepend the live bounds when they are not tabulated. On
        // the full-screen dev entry they always are, and the
        // table is unchanged.
        let liveW = Double(scrollView.bounds.width.rounded())
        let liveH = Double(scrollView.bounds.height.rounded())
        if liveW > 0 && !sizes.contains(where: { $0.0 == liveW && $0.1 == liveH }) {
            sizes.insert((liveW, liveH), at: 0)
        }
        let cLat = (SpikeGeom.boundsSW.lat + SpikeGeom.boundsNE.lat) / 2.0
        let cLng = (SpikeGeom.boundsSW.lng + SpikeGeom.boundsNE.lng) / 2.0
        let c = SpikeGeom.globalPx(lat: cLat, lng: cLng)
        let localX = Double(c.x - tiledView.originGlobal.x)
        let localY = Double(c.y - tiledView.originGlobal.y)
        var lines: [String] = []
        for (w, h) in sizes {
            let zoom = SpikeGeom.leafletFitZoom(viewport: CGSize(width: w, height: h))
            let s = pow(2.0, Double(zoom - SpikeGeom.refZoom))
            let cw = Double(contentUnits.width) * s
            let ch = Double(contentUnits.height) * s
            let ix = max(0.0, (w - cw) / 2.0)
            let iy = max(0.0, (h - ch) / 2.0)
            var ox = localX * s - w / 2.0
            var oy = localY * s - h / 2.0
            ox = min(max(ox, -ix), cw - w + ix)
            oy = min(max(oy, -iy), ch - h + iy)
            var vis = CGRect(x: ox / s, y: oy / s, width: w / s, height: h / s)
            vis = vis.intersection(CGRect(origin: .zero, size: contentUnits))
            var cells = 0
            if !vis.isNull && !vis.isEmpty {
                let span = 256.0 * pow(2.0, Double(SpikeGeom.refZoom - zoom))
                let gx0 = vis.minX + Double(tiledView.originGlobal.x)
                let gy0 = vis.minY + Double(tiledView.originGlobal.y)
                let tx0 = Int(floor(gx0 / span))
                let ty0 = Int(floor(gy0 / span))
                let tx1 = Int(floor((gx0 + Double(vis.width) - 0.001) / span))
                let ty1 = Int(floor((gy0 + Double(vis.height) - 0.001) / span))
                if tx1 >= tx0 && ty1 >= ty0 { cells = (tx1 - tx0 + 1) * (ty1 - ty0 + 1) }
            }
            lines.append(String(format: "%.0fx%.0f fit %d inset t%.0f l%.0f off (%.0f,%.0f) cells %d",
                                w, h, zoom, iy, ix, ox, oy, cells))
        }
        return lines
    }

    func diagnosticsSnapshot() -> [String: Any] {
        refreshDiagnostics()
        var snap: [String: Any] = [
            "fitZoom": fitZoom,
            "currentZoom": ((19.0 + log2(Double(scrollView.zoomScale))) * 100).rounded() / 100,
            "tilesInView": census.inView,
            "tilesExact": census.exact,
            "tilesSubstituted": census.substituted,
            "missingTiles": census.missing,
            "tilesDrawn": tiledView.drawnExact,
            "drawCalls": tiledView.drawCalls,
            "tilesUnpainted": census.unpainted,
            "packTileCount": packTileCount,
            "tilesStatus": tilesStatus,
            "svBounds": String(format: "%.0fx%.0f", scrollView.bounds.width, scrollView.bounds.height),
            "contentOffset": String(format: "(%.1f,%.1f)", scrollView.contentOffset.x, scrollView.contentOffset.y),
            "contentInset": String(format: "(%.0f,%.0f,%.0f,%.0f)", scrollView.contentInset.top, scrollView.contentInset.left, scrollView.contentInset.bottom, scrollView.contentInset.right),
            "fitTrace": fitTrace,
            "parity": paritySweep(),
            "pinsTotal": pins.count,
            "pinsByClass": pins.isEmpty ? "" : String(
                format: "places %d · rr %d · svc %d · se %d · always %d",
                classCount("places"), classCount("rr"), classCount("svc"),
                classCount("se"), classCount("always")),
            "pinsVisible": visiblePinCount(),
            "lastTap": lastTapName,
            "lastPopup": lastPopupName,
            "routeName": currentRoute?.label ?? "",
            "lastSettleComposites": lastSettleComposites,
            "tileEngine": "layer",
            "openMs": openMs,
            "fitComposites": fitComposites,
            "compositesTotal": compositesTotal,
            "visibleLayers": tileLayers.count,
            "production": production ? 1 : 0,
            "routeNodes": currentRoute?.nodesWeb ?? 0,
            "routeNodesDrawn": currentRoute?.points.count ?? 0,
            "routeDistFt": currentRoute?.distFt ?? 0,
            "routeCoordFtWeb": currentRoute?.coordFtWeb ?? 0,
            "routeCoordFtNative": currentRoute?.coordFtNative ?? 0,
        ]
        // Step 10 (msg 168): the cold segment keys, added only
        // when every stamp landed (the present path); omitted
        // entirely otherwise, so the key set is otherwise
        // exactly the pre-instrument set.
        if coldTapWall > 0 && coldPrepWall > 0 && coldCallWall > 0
            && coldParsedWall > 0 && coldDidLoadWall > 0
            && coldAppearWall > 0 && coldPaintedWall > 0 {
            snap["coldTotalMs"] = Int((coldPaintedWall - coldTapWall).rounded())
            snap["coldJsPrepMs"] = Int((coldPrepWall - coldTapWall).rounded())
            snap["coldBridgeMs"] = Int((coldCallWall - coldPrepWall).rounded())
            snap["coldParseMs"] = Int((coldParsedWall - coldCallWall).rounded())
            snap["coldLoadMs"] = Int((coldDidLoadWall - coldParsedWall).rounded())
            snap["coldPresentMs"] = Int((coldAppearWall - coldDidLoadWall).rounded())
            snap["coldPaintMs"] = Int((coldPaintedWall - coldAppearWall).rounded())
        }
        return snap
    }

    @objc private func doneTapped() {
        onClose?()
    }
}

// MARK: - Step 5P micro-spike (Claude msg 160): layer-composited tiles
//
// Premise gate for Option A: composite the pre-decoded tile PNGs as
// plain CALayer contents -- one layer per visible cell, positioned by
// the proven SpikeGeom geometry inside the same scroll/zoom machinery
// -- instead of asking CATiledLayer to rasterize them through draw().
// BARE view by design: resort at fit, pan + pinch, instruments. No
// pins, chips, routes, or popups (they port only if this passes).
// (The CATiledLayer surface this spike was gated against was
// retired by the step-6 port and deleted in the step-7 cleanup;
// this surface and the full map now share the one compositing
// path, and the mini-map render is the tile source's other
// consumer.)

final class LayerSpikeViewController: UIViewController, UIScrollViewDelegate {
    private let scrollView = UIScrollView()
    // The compositing surface: a plain UIView with NO draw(_:)
    // override -- tiles are sublayer contents, never drawn. (An
    // overridden draw on a 6785x7897 pt view would invite a
    // full-content backing store: the failure being escaped.)
    private let contentView = UIView()
    // Tile source: a SpikeTiledView that is never added to a view
    // hierarchy, so nothing ever paints through it (its drawCalls
    // counter in the snapshot proves it). It exists to reuse the
    // shipped tile ladder + NSCache decode path (layerTile /
    // resolution) instead of duplicating them.
    private let tileSource = SpikeTiledView(frame: .zero)
    private let diagLabel = UILabel()
    private let titleLabel = UILabel()
    private let doneButton = UIButton(type: .system)

    private var lastFitSize: CGSize = .zero
    private var contentUnits: CGSize = .zero
    private var userInteracted = false
    private var applyingFit = false
    private var fitTrace: [String] = []
    private var lastLayoutSize: CGSize = .zero
    private(set) var fitZoom: Int = 0
    private var tilesStatus: String = "ok"
    private var packTileCount: Int = 0
    private var census: (inView: Int, exact: Int, substituted: Int, missing: Int, unpainted: Int) = (0, 0, 0, 0, 0)

    var onClose: (() -> Void)?

    // Layer model state. Keys reuse the painted-cell encoding:
    // (level << 40) | (ty << 20) | tx.
    private var level: Int = 15
    private var tileLayers: [Int: CALayer] = [:]
    private var lastSyncSignature = ""
    // Instruments (design_20261011.md section 4).
    private(set) var compositesTotal = 0
    private(set) var fitComposites = -1
    private(set) var lastSettleComposites = -1
    private var settlePending = false
    private var settleStartComposites = 0
    private var hasAppeared = false
    private var openStart: CFTimeInterval? = nil
    private(set) var layerOpenMs = -1

    private func trace(_ s: String) {
        fitTrace.append(s)
        if fitTrace.count > 16 { fitTrace.removeFirst(fitTrace.count - 16) }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = SpikeTiledView.beige

        locateTiles()

        // Content = TPCP_RESORT_MAXBOUNDS in zoom-19 px, the same
        // frame the CATiledLayer spike uses.
        let nw = SpikeGeom.globalPx(lat: SpikeGeom.maxNE.lat, lng: SpikeGeom.maxSW.lng)
        let se = SpikeGeom.globalPx(lat: SpikeGeom.maxSW.lat, lng: SpikeGeom.maxNE.lng)
        tileSource.originGlobal = nw
        contentView.frame = CGRect(x: 0, y: 0, width: se.x - nw.x, height: se.y - nw.y)
        contentUnits = contentView.frame.size
        contentView.backgroundColor = SpikeTiledView.beige

        scrollView.delegate = self
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.contentSize = contentView.frame.size
        trace(String(format: "LOAD cs %.0fx%.0f layerFrame %.0fx%.0f",
                     scrollView.contentSize.width, scrollView.contentSize.height,
                     contentView.frame.width, contentView.frame.height))
        scrollView.backgroundColor = SpikeTiledView.beige
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.addSubview(contentView)
        view.addSubview(scrollView)

        titleLabel.text = "Layer spike (dev)"
        titleLabel.font = UIFont.boldSystemFont(ofSize: 13)
        titleLabel.textColor = .white
        titleLabel.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        titleLabel.textAlignment = .center
        titleLabel.layer.cornerRadius = 6
        titleLabel.layer.masksToBounds = true
        view.addSubview(titleLabel)

        doneButton.setTitle("Done", for: .normal)
        doneButton.titleLabel?.font = UIFont.boldSystemFont(ofSize: 14)
        doneButton.setTitleColor(.white, for: .normal)
        doneButton.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        doneButton.layer.cornerRadius = 6
        doneButton.contentEdgeInsets = UIEdgeInsets(top: 6, left: 14, bottom: 6, right: 14)
        doneButton.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
        view.addSubview(doneButton)

        diagLabel.font = UIFont.monospacedSystemFont(ofSize: 10, weight: .regular)
        diagLabel.textColor = .white
        diagLabel.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        diagLabel.numberOfLines = 0
        diagLabel.layer.cornerRadius = 6
        diagLabel.layer.masksToBounds = true
        view.addSubview(diagLabel)
    }

    // Same bundle lookup + manifest read as
    // SpikeViewController.locateTiles, writing to the tile source.
    private func locateTiles() {
        var tilesURL = Bundle.main.url(forResource: "tiles", withExtension: nil)
        if tilesURL == nil, let res = Bundle.main.resourceURL {
            let candidate = res.appendingPathComponent("tiles")
            if FileManager.default.fileExists(atPath: candidate.path) {
                tilesURL = candidate
            }
        }
        guard let base = tilesURL else {
            tilesStatus = "tiles folder MISSING from app bundle (Xcode Add Files step not done)"
            return
        }
        let resort = base.appendingPathComponent("resort")
        if FileManager.default.fileExists(atPath: resort.path) {
            tileSource.tilesRoot = resort
        } else {
            tilesStatus = "tiles/resort MISSING from app bundle"
            return
        }
        let manifest = base.appendingPathComponent("manifest.json")
        if let data = try? Data(contentsOf: manifest),
           let obj = try? JSONSerialization.jsonObject(with: data),
           let dict = obj as? [String: Any],
           let n = dict["keyCount"] as? Int {
            packTileCount = n
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        hasAppeared = true
        trace(String(format: "APPEAR cs %.0fx%.0f in t%.0f l%.0f off (%.0f,%.0f) sv %.0fx%.0f",
                     scrollView.contentSize.width, scrollView.contentSize.height,
                     scrollView.contentInset.top, scrollView.contentInset.left,
                     scrollView.contentOffset.x, scrollView.contentOffset.y,
                     scrollView.bounds.width, scrollView.bounds.height))
        // The open-to-painted clock starts here, with the view on
        // screen at its final bounds and the fit already applied:
        // it measures the rendering approach, not the modal
        // presentation or the bridge (design section 4.1).
        if openStart == nil { openStart = CACurrentMediaTime() }
        performOpenSyncIfNeeded()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scrollView.frame = view.bounds
        if scrollView.bounds.size != lastLayoutSize {
            lastLayoutSize = scrollView.bounds.size
            trace(String(format: "LAYOUT sv %.0fx%.0f view %.0fx%.0f inter %d",
                         scrollView.bounds.width, scrollView.bounds.height,
                         view.bounds.width, view.bounds.height,
                         userInteracted ? 1 : 0))
        }
        let safe = view.safeAreaInsets
        titleLabel.frame = CGRect(x: safe.left + 10, y: safe.top + 8, width: 168, height: 24)
        let db = doneButton.intrinsicContentSize
        doneButton.frame = CGRect(x: view.bounds.width - safe.right - db.width - 10,
                                  y: safe.top + 8, width: db.width, height: 24)
        diagLabel.frame = CGRect(x: safe.left + 10,
                                 y: view.bounds.height - safe.bottom - 100 - 8,
                                 width: view.bounds.width - safe.left - safe.right - 20,
                                 height: 100)
        // Re-fit on size change until the user takes over (same
        // discipline as the CATiledLayer spike: the first layout
        // pass can run at a transient presentation size).
        if !userInteracted && scrollView.bounds.size != lastFitSize
            && scrollView.bounds.width > 0 && scrollView.bounds.height > 0 {
            lastFitSize = scrollView.bounds.size
            applyFit()
        }
    }

    private func applyFit() {
        let size = scrollView.bounds.size
        let csStart = scrollView.contentSize
        fitZoom = SpikeGeom.leafletFitZoom(viewport: size)
        scrollView.minimumZoomScale = CGFloat(pow(2.0, Double(SpikeGeom.minMapZoom - SpikeGeom.refZoom)))
        scrollView.maximumZoomScale = 1.0
        level = fitZoom
        let scale = CGFloat(pow(2.0, Double(fitZoom - SpikeGeom.refZoom)))
        applyingFit = true
        scrollView.zoomScale = scale
        applyingFit = false
        centerOnResortBounds(scale: scale)
        trace(String(format: "FIT vp %.0fx%.0f fz %d sc %.4f csStart %.0fx%.0f cs %.0fx%.0f -> in t%.0f l%.0f off (%.0f,%.0f)",
                     size.width, size.height, fitZoom, Double(scale),
                     csStart.width, csStart.height,
                     scrollView.contentSize.width, scrollView.contentSize.height,
                     scrollView.contentInset.top, scrollView.contentInset.left,
                     scrollView.contentOffset.x, scrollView.contentOffset.y))
        refreshDiagnostics()
        if hasAppeared { performOpenSyncIfNeeded() }
    }

    // Mirrored from SpikeViewController.centerOnResortBounds --
    // keep in step with the original. Displayed size comes from the
    // stored contentUnits, never scrollView.contentSize.
    private func centerOnResortBounds(scale: CGFloat) {
        let cLat = (SpikeGeom.boundsSW.lat + SpikeGeom.boundsNE.lat) / 2.0
        let cLng = (SpikeGeom.boundsSW.lng + SpikeGeom.boundsNE.lng) / 2.0
        let c = SpikeGeom.globalPx(lat: cLat, lng: cLng)
        let localX = Double(c.x - tileSource.originGlobal.x)
        let localY = Double(c.y - tileSource.originGlobal.y)
        let vp = scrollView.bounds.size
        let cw = Double(contentUnits.width) * Double(scale)
        let ch = Double(contentUnits.height) * Double(scale)
        let ix = max(0.0, (Double(vp.width) - cw) / 2.0)
        let iy = max(0.0, (Double(vp.height) - ch) / 2.0)
        scrollView.contentInset = UIEdgeInsets(top: CGFloat(iy), left: CGFloat(ix),
                                               bottom: CGFloat(iy), right: CGFloat(ix))
        var ox = localX * Double(scale) - Double(vp.width) / 2.0
        var oy = localY * Double(scale) - Double(vp.height) / 2.0
        ox = min(max(ox, -ix), cw - Double(vp.width) + ix)
        oy = min(max(oy, -iy), ch - Double(vp.height) + iy)
        scrollView.contentOffset = CGPoint(x: ox, y: oy)
    }

    // MARK: UIScrollViewDelegate

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        userInteracted = true
    }

    func scrollViewWillBeginZooming(_ scrollView: UIScrollView, with view: UIView?) {
        userInteracted = true
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? {
        return contentView
    }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        if !applyingFit { userInteracted = true }
        // Level selection mirrors SpikeViewController.scrollViewDidZoom
        // exactly: rounded map zoom from the scale, clamped 13...19.
        let z = 19.0 + log2(Double(scrollView.zoomScale))
        let l = Int(min(Double(SpikeGeom.maxMapZoom),
                        max(Double(SpikeGeom.minMapZoom), z.rounded())))
        if l != level {
            level = l
            if hasAppeared { syncVisibleTiles(); refreshDiagnostics() }
        }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if hasAppeared { syncVisibleTiles() }
    }

    // Gesture settle: same end-hooks and 60 ms coalescing shape as
    // the step-5 settleRepaint, but the measurement is taken
    // SYNCHRONOUSLY after the settle sync -- layer contents
    // assignments have no asynchronous paint tail, so the value is
    // final in the same turn and cannot be stranded by a quick Done
    // (the step-5 instrument gap, design section 4.0).
    private func settleCompositeSync() {
        refreshDiagnostics()
        if settlePending { return }
        settlePending = true
        settleStartComposites = compositesTotal
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { [weak self] in
            guard let self = self else { return }
            self.settlePending = false
            self.syncVisibleTiles()
            self.lastSettleComposites = self.compositesTotal - self.settleStartComposites
            self.refreshDiagnostics()
        }
    }

    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
        settleCompositeSync()
    }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { settleCompositeSync() }
    }
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        settleCompositeSync()
    }

    // MARK: layer sync

    /// The visible cell range at the current level, computed with
    /// the census math from SpikeViewController.refreshDiagnostics.
    /// Sync and census share this one function (they cannot drift).
    private func visibleCellRange() -> (tx0: Int, ty0: Int, tx1: Int, ty1: Int, span: Double)? {
        let s = Double(scrollView.zoomScale)
        guard s > 0 else { return nil }
        var vis = CGRect(x: Double(scrollView.contentOffset.x) / s,
                         y: Double(scrollView.contentOffset.y) / s,
                         width: Double(scrollView.bounds.width) / s,
                         height: Double(scrollView.bounds.height) / s)
        vis = vis.intersection(contentView.bounds)
        if vis.isNull || vis.isEmpty { return nil }
        let span = 256.0 * pow(2.0, Double(SpikeGeom.refZoom - level))
        let gx0 = vis.minX + Double(tileSource.originGlobal.x)
        let gy0 = vis.minY + Double(tileSource.originGlobal.y)
        let tx0 = Int(floor(gx0 / span))
        let ty0 = Int(floor(gy0 / span))
        let tx1 = Int(floor((gx0 + Double(vis.width) - 0.001) / span))
        let ty1 = Int(floor((gy0 + Double(vis.height) - 0.001) / span))
        if tx1 < tx0 || ty1 < ty0 { return nil }
        return (tx0, ty0, tx1, ty1, span)
    }

    /// Reconcile the tile layers with the visible set: create a
    /// layer for each newly visible resolvable cell (ONE contents
    /// assignment = ONE composite), prune layers that left the set.
    /// The pack is static, so an unchanged (level, range) signature
    /// makes the call a no-op -- most pan ticks cost one range
    /// computation and one comparison.
    private func syncVisibleTiles() {
        guard let r = visibleCellRange() else { return }
        let signature = "\(level)/\(r.tx0)/\(r.ty0)/\(r.tx1)/\(r.ty1)"
        if signature == lastSyncSignature { return }
        lastSyncSignature = signature
        var desired = Set<Int>()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for ty in r.ty0...r.ty1 {
            for tx in r.tx0...r.tx1 {
                let key = (level << 40) | (ty << 20) | tx
                let t = tileSource.layerTile(level: level, tx: tx, ty: ty)
                guard let img = t.image else { continue }
                desired.insert(key)
                if tileLayers[key] != nil { continue }
                let layer = CALayer()
                layer.frame = CGRect(
                    x: CGFloat(Double(tx) * r.span - Double(tileSource.originGlobal.x)),
                    y: CGFloat(Double(ty) * r.span - Double(tileSource.originGlobal.y)),
                    width: CGFloat(r.span), height: CGFloat(r.span))
                if t.isSubstitute {
                    // The ancestor's sub-quadrant for this cell
                    // (design section 2.5): same source image, same
                    // geographic sub-region paintCells clips to.
                    let n = 1 << t.step
                    let qx = tx - t.ax * n
                    let qy = ty - t.ay * n
                    layer.contentsRect = CGRect(x: CGFloat(qx) / CGFloat(n),
                                                y: CGFloat(qy) / CGFloat(n),
                                                width: 1.0 / CGFloat(n),
                                                height: 1.0 / CGFloat(n))
                }
                layer.contents = img.cgImage
                compositesTotal += 1
                contentView.layer.addSublayer(layer)
                tileLayers[key] = layer
            }
        }
        let stale = tileLayers.keys.filter { !desired.contains($0) }
        for key in stale {
            tileLayers[key]?.removeFromSuperlayer()
            tileLayers.removeValue(forKey: key)
        }
        CATransaction.commit()
    }

    /// The first sync after appear runs inside an explicit
    /// transaction whose completion block timestamps the moment the
    /// render server presents the frame carrying the last tile
    /// contents -- the open-to-fully-painted measurement (design
    /// section 4.1). Later calls are plain syncs.
    private func performOpenSyncIfNeeded() {
        if layerOpenMs >= 0 { syncVisibleTiles(); return }
        if openStart == nil { openStart = CACurrentMediaTime() }
        let start = openStart ?? CACurrentMediaTime()
        let before = compositesTotal
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            guard let self = self else { return }
            if self.layerOpenMs < 0 {
                self.layerOpenMs = Int(((CACurrentMediaTime() - start) * 1000.0).rounded())
            }
            self.refreshDiagnostics()
        }
        syncVisibleTiles()
        CATransaction.commit()
        if fitComposites < 0 { fitComposites = compositesTotal - before }
    }

    // MARK: diagnostics

    private func refreshDiagnostics() {
        let s = Double(scrollView.zoomScale)
        guard s > 0 else { return }
        var inView = 0, exact = 0, subst = 0, missing = 0, unpainted = 0
        if let r = visibleCellRange() {
            for ty in r.ty0...r.ty1 {
                for tx in r.tx0...r.tx1 {
                    inView += 1
                    let res = tileSource.resolution(z: level - 1, x: tx, y: ty)
                    switch res {
                    case 0: exact += 1
                    case 1: subst += 1
                    default: missing += 1
                    }
                    let key = (level << 40) | (ty << 20) | tx
                    if res != 2 && tileLayers[key] == nil { unpainted += 1 }
                }
            }
        }
        census = (inView, exact, subst, missing, unpainted)
        let zoomNow = 19.0 + log2(s)
        let bo = scrollView.bounds.size
        let of = scrollView.contentOffset
        let ci = scrollView.contentInset
        diagLabel.text = String(
            format: " fit zoom %d · zoom %.2f · layers %d\n tiles in view %d — exact %d · substituted %d · missing %d · unpainted %d\n pack %@ · %@\n sv %.0fx%.0f · off (%.0f,%.0f) · inset t%.0f l%.0f b%.0f r%.0f",
            fitZoom, zoomNow, tileLayers.count,
            inView, exact, subst, missing, unpainted,
            packTileCount > 0 ? "\(packTileCount) tiles" : "size unknown",
            tilesStatus,
            bo.width, bo.height, of.x, of.y, ci.top, ci.left, ci.bottom, ci.right)
        diagLabel.text = (diagLabel.text ?? "") + String(
            format: "\n open %d ms · fit comp %d · comp %d · settle comp %d · tile draws %d",
            layerOpenMs, fitComposites, compositesTotal, lastSettleComposites, tileSource.drawCalls)
        if let last = fitTrace.last {
            diagLabel.text = (diagLabel.text ?? "") + "\n " + last
        }
    }

    func diagnosticsSnapshot() -> [String: Any] {
        refreshDiagnostics()
        return [
            "layerSpike": 1,
            "fitZoom": fitZoom,
            "currentZoom": ((19.0 + log2(Double(scrollView.zoomScale))) * 100).rounded() / 100,
            "tilesInView": census.inView,
            "tilesExact": census.exact,
            "tilesSubstituted": census.substituted,
            "missingTiles": census.missing,
            "tilesUnpainted": census.unpainted,
            "packTileCount": packTileCount,
            "tilesStatus": tilesStatus,
            "svBounds": String(format: "%.0fx%.0f", scrollView.bounds.width, scrollView.bounds.height),
            "contentOffset": String(format: "(%.1f,%.1f)", scrollView.contentOffset.x, scrollView.contentOffset.y),
            "contentInset": String(format: "(%.0f,%.0f,%.0f,%.0f)", scrollView.contentInset.top, scrollView.contentInset.left, scrollView.contentInset.bottom, scrollView.contentInset.right),
            "fitTrace": fitTrace,
            "layerOpenMs": layerOpenMs,
            "fitComposites": fitComposites,
            "compositesTotal": compositesTotal,
            "lastSettleComposites": lastSettleComposites,
            "tileDrawCalls": tileSource.drawCalls,
            "sourceDrawCalls": tileSource.drawCalls,
            "visibleLayers": tileLayers.count,
        ]
    }

    @objc private func doneTapped() {
        onClose?()
    }
}

// MARK: - Capacitor plugin (ONE method: present)

@objc(NativeMapSpikePlugin)
public class NativeMapSpikePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeMapSpikePlugin"
    public let jsName = "NativeMapSpike"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "present", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "miniMap", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentLayerSpike", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showPinPopup", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLayers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeSpike", returnType: CAPPluginReturnPromise)
    ]

    private var spikeVC: SpikeViewController?
    private var pendingCall: CAPPluginCall?
    private var layerVC: LayerSpikeViewController?
    private var layerPendingCall: CAPPluginCall?

    @objc func present(_ call: CAPPluginCall) {
        // Step 10 (msg 168): the received stamp and the JS
        // stamps are read at entry, before the main-queue hop,
        // so coldBridge ends here (stringify + marshalling +
        // dispatch) and coldParse absorbs the queue wait.
        let callReceivedWall = spikeWallMsNow()
        let tapWallMs = call.getDouble("tapWallMs") ?? 0
        let prepWallMs = call.getDouble("prepWallMs") ?? 0
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else {
                call.reject("NativeMapSpike: no host view controller")
                return
            }
            if self.spikeVC != nil {
                call.reject("NativeMapSpike: spike already open")
                return
            }
            let vc = SpikeViewController()
            vc.production = call.getBool("production") ?? false
            vc.coldTapWall = tapWallMs
            vc.coldPrepWall = prepWallMs
            vc.coldCallWall = callReceivedWall
            // Step 3: pin data + initial layer state from the web
            // (tpcpBuildNativePinData in app.html), as a JSON string
            // (parsed with the same JSONSerialization the tile
            // manifest read uses). Absent -> no pins (steps 1-2 view).
            if let json = call.getString("pinsJson"),
               let data = json.data(using: .utf8),
               let arr = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] {
                let origin = SpikeGeom.globalPx(lat: SpikeGeom.maxNE.lat,
                                                lng: SpikeGeom.maxSW.lng)
                vc.pins = arr.compactMap { o in
                    guard let id = o["id"] as? String,
                          let layer = o["layer"] as? String,
                          let lat = (o["lat"] as? NSNumber)?.doubleValue,
                          let lon = (o["lon"] as? NSNumber)?.doubleValue
                    else { return nil }
                    let gp = SpikeGeom.globalPx(lat: lat, lng: lon)
                    return SpikePin(
                        id: id,
                        name: (o["name"] as? String) ?? "",
                        layer: layer,
                        contentPoint: CGPoint(x: gp.x - origin.x,
                                              y: gp.y - origin.y),
                        radius: CGFloat((o["radius"] as? NSNumber)?.doubleValue ?? 9),
                        weight: CGFloat((o["weight"] as? NSNumber)?.doubleValue ?? 2),
                        fill: UIColor(spikeHex: (o["fill"] as? String) ?? "#173A5E"),
                        alpha: CGFloat((o["alpha"] as? NSNumber)?.doubleValue ?? 0.95))
                }
            }
            // Step 4: the acceptance route suite (same JSON-string
            // discipline as the pins). coordFt is re-derived here
            // from the received lat/lons; the points are projected
            // through the same globalPx-origin path as the pins.
            if let json = call.getString("routesJson"),
               let data = json.data(using: .utf8),
               let arr = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] {
                let origin = SpikeGeom.globalPx(lat: SpikeGeom.maxNE.lat,
                                                lng: SpikeGeom.maxSW.lng)
                vc.routes = arr.compactMap { o in
                    guard let id = o["id"] as? String,
                          let label = o["label"] as? String,
                          let raw = o["coords"] as? [[Any]]
                    else { return nil }
                    var pts: [CGPoint] = []
                    var coordFt = 0.0
                    var prev: (Double, Double)? = nil
                    for c in raw {
                        guard c.count == 2,
                              let latN = c[0] as? NSNumber,
                              let lonN = c[1] as? NSNumber
                        else { continue }
                        let lat = latN.doubleValue, lon = lonN.doubleValue
                        if let p = prev {
                            coordFt += SpikeGeom.havFt(lat1: p.0, lon1: p.1, lat2: lat, lon2: lon)
                        }
                        prev = (lat, lon)
                        let gp = SpikeGeom.globalPx(lat: lat, lng: lon)
                        pts.append(CGPoint(x: gp.x - origin.x, y: gp.y - origin.y))
                    }
                    guard pts.count > 1 else { return nil }
                    return SpikeRoute(
                        id: id, label: label, points: pts,
                        nodesWeb: (o["nodes"] as? NSNumber)?.intValue ?? pts.count,
                        distFt: (o["distFt"] as? NSNumber)?.intValue ?? 0,
                        coordFtWeb: (o["coordFt"] as? NSNumber)?.intValue ?? 0,
                        coordFtNative: Int(coordFt.rounded()))
                }
            }
            vc.coldParsedWall = spikeWallMsNow()
            vc.initialLayers = (places: call.getBool("layerPlaces") ?? true,
                                svc: call.getBool("layerSvc") ?? false,
                                se: call.getBool("layerSe") ?? false)
            vc.onPinTap = { [weak self] id in
                self?.notifyListeners("pinTap", data: ["id": id])
            }
            vc.onPinDirections = { [weak self] id in
                self?.notifyListeners("pinDirections", data: ["id": id])
            }
            vc.modalPresentationStyle = .fullScreen
            self.spikeVC = vc
            self.pendingCall = call
            vc.onClose = { [weak self, weak vc] in
                guard let self = self, let vc = vc else { return }
                let snapshot = vc.diagnosticsSnapshot()
                self.pendingCall?.resolve(snapshot)
                self.pendingCall = nil
                self.spikeVC = nil
                vc.dismiss(animated: true)
            }
            // Step 11 (msg 168 follow-up): the animated modal
            // transition measured ~510 ms of the ~655 ms cold
            // open (step-10 cold instrument), so present
            // unanimated -- that is the halving lever. Dismissal
            // stays animated (in onClose, above).
            host.present(vc, animated: false)
        }
    }

    @objc func presentLayerSpike(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else {
                call.reject("NativeMapSpike: no host view controller")
                return
            }
            if self.spikeVC != nil || self.layerVC != nil {
                call.reject("NativeMapSpike: a spike is already open")
                return
            }
            let vc = LayerSpikeViewController()
            vc.modalPresentationStyle = .fullScreen
            self.layerVC = vc
            self.layerPendingCall = call
            vc.onClose = { [weak self, weak vc] in
                guard let self = self, let vc = vc else { return }
                let snapshot = vc.diagnosticsSnapshot()
                self.layerPendingCall?.resolve(snapshot)
                self.layerPendingCall = nil
                self.layerVC = nil
                vc.dismiss(animated: true)
            }
            host.present(vc, animated: true)
        }
    }

    @objc func miniMap(_ call: CAPPluginCall) {
        let w = call.getDouble("width") ?? 0
        let h = call.getDouble("height") ?? 0
        var pins: [(lat: Double, lon: Double, fill: UIColor, radius: CGFloat, weight: CGFloat)] = []
        if let json = call.getString("pinsJson"),
           let data = json.data(using: .utf8),
           let arr = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] {
            pins = arr.compactMap { o in
                guard let lat = (o["lat"] as? NSNumber)?.doubleValue,
                      let lon = (o["lon"] as? NSNumber)?.doubleValue
                else { return nil }
                return (lat: lat, lon: lon,
                        fill: UIColor(spikeHex: (o["fill"] as? String) ?? "#1A6860"),
                        radius: CGFloat((o["radius"] as? NSNumber)?.doubleValue ?? 5),
                        weight: CGFloat((o["weight"] as? NSNumber)?.doubleValue ?? 1.4))
            }
        }
        DispatchQueue.main.async {
            guard let img = SpikeTiledView.renderMiniMap(
                    size: CGSize(width: w, height: h), pins: pins),
                  let png = img.pngData() else {
                call.reject("NativeMapSpike: mini-map render failed")
                return
            }
            call.resolve(["image": png.base64EncodedString(), "renderer": "native"])
        }
    }

    @objc func showPinPopup(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? ""
        let sub = call.getString("sub") ?? ""
        let hasDir = call.getBool("hasDir") ?? false
        let pinId = call.getString("pinId") ?? ""
        DispatchQueue.main.async {
            self.spikeVC?.showPinPopup(name: name, sub: sub,
                                       hasDir: hasDir, pinId: pinId)
            call.resolve()
        }
    }

    @objc func setLayers(_ call: CAPPluginCall) {
        let places = call.getBool("places") ?? true
        let svc = call.getBool("svc") ?? false
        let se = call.getBool("se") ?? false
        DispatchQueue.main.async {
            self.spikeVC?.setLayers(places: places, svc: svc, se: se)
            call.resolve()
        }
    }

    @objc func closeSpike(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.spikeVC?.onClose?()
            call.resolve()
        }
    }
}

// MARK: - Bridge host (explicit plugin registration)

/// The bridge view controller for the whole app. Capacitor only
/// auto-registers plugins from npm packages, so this app-target plugin
/// is registered by hand here. SceneDelegate instantiates this class
/// in code, and Main.storyboard names it as its custom class, so the
/// registration happens on whichever path creates the bridge.
public final class NativeMapSpikeBridgeViewController: CAPBridgeViewController {
    public override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeMapSpikePlugin())
    }
}
