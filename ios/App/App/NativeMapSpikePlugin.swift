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
}

// MARK: - Tiled view (CATiledLayer)

/// CATiledLayer with the new-tile fade disabled. fadeDuration is a
/// class-level member of CATiledLayer (there is no instance setter --
/// the first Xcode compile of this file proved that), and the spike
/// verdict must see first paint exactly as composited, so this
/// subclass pins the fade to zero.
final class SpikeTiledLayer: CATiledLayer {
    override class func fadeDuration() -> CFTimeInterval { return 0 }
}

final class SpikeTiledView: UIView {
    override class var layerClass: AnyClass { return SpikeTiledLayer.self }
    private var tiledLayer: CATiledLayer { return layer as! CATiledLayer }

    /// .../tiles/resort inside the app bundle (nil if the folder is absent).
    var tilesRoot: URL?
    /// Global zoom-19 px coordinates of this view's top-left corner
    /// (the MAXBOUNDS north-west corner). View-local + origin = global.
    var originGlobal: CGPoint = .zero
    /// Map zoom whose tiles are currently being drawn (13...19).
    var level: Int = 15 {
        didSet { if level != oldValue { layer.setNeedsDisplay() } }
    }

    private let imageCache = NSCache<NSString, UIImage>()
    private let countLock = NSLock()
    private(set) var drawnExact: Int = 0
    private(set) var drawCalls: Int = 0
    private var paintedCells = Set<Int>()

    private func cellKey(level: Int, x: Int, y: Int) -> Int {
        (level << 40) | (y << 20) | x
    }
    func wasPainted(level: Int, x: Int, y: Int) -> Bool {
        countLock.lock(); defer { countLock.unlock() }
        return paintedCells.contains(cellKey(level: level, x: x, y: y))
    }
    private func markPainted(level: Int, x: Int, y: Int) {
        paintedCells.insert(cellKey(level: level, x: x, y: y))
    }

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
        tiledLayer.tileSize = CGSize(width: 256, height: 256)
        // Level selection is driven deterministically from the scroll
        // view's zoom scale (see SpikeViewController.scrollViewDidZoom),
        // so the layer keeps a single detail level and re-renders its
        // tiles under the zoom transform — Core Animation does the
        // compositing, which is precisely the premise under test.
        tiledLayer.levelsOfDetail = 1
        // tile fade is disabled via SpikeTiledLayer (above)
        contentScaleFactor = UIScreen.main.scale
        backgroundColor = SpikeTiledView.beige
        imageCache.countLimit = 512
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

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        countLock.lock(); drawCalls += 1; countLock.unlock()
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
                    countLock.lock(); drawnExact += 1
                    markPainted(level: level, x: tx, y: ty); countLock.unlock()
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
                        countLock.lock()
                        markPainted(level: level, x: tx, y: ty)
                        countLock.unlock()
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

// MARK: - Spike view controller

final class SpikeViewController: UIViewController, UIScrollViewDelegate {
    private let scrollView = UIScrollView()
    private let tiledView = SpikeTiledView()
    private let diagLabel = UILabel()
    private let titleLabel = UILabel()
    private let doneButton = UIButton(type: .system)

    private var lastFitSize: CGSize = .zero
    private var userInteracted = false
    private var applyingFit = false
    private(set) var fitZoom: Int = 0
    private var tilesStatus: String = "ok"
    private var packTileCount: Int = 0
    private var census: (inView: Int, exact: Int, substituted: Int, missing: Int, unpainted: Int) = (0, 0, 0, 0, 0)

    var onClose: (() -> Void)?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = SpikeTiledView.beige

        locateTiles()

        // Content = TPCP_RESORT_MAXBOUNDS in zoom-19 px (the web map's
        // own pan clamp, maxBoundsViscosity 1.0): the scroll view can
        // never leave it by more than the rubber-band bounce.
        let nw = SpikeGeom.globalPx(lat: SpikeGeom.maxNE.lat, lng: SpikeGeom.maxSW.lng)
        let se = SpikeGeom.globalPx(lat: SpikeGeom.maxSW.lat, lng: SpikeGeom.maxNE.lng)
        tiledView.originGlobal = nw
        tiledView.frame = CGRect(x: 0, y: 0, width: se.x - nw.x, height: se.y - nw.y)

        scrollView.delegate = self
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.contentSize = tiledView.frame.size
        scrollView.backgroundColor = SpikeTiledView.beige
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.addSubview(tiledView)
        view.addSubview(scrollView)

        titleLabel.text = "Native map spike (dev)"
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
        super.viewDidAppear(animated)
        tiledView.setNeedsDisplay()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scrollView.frame = view.bounds
        let safe = view.safeAreaInsets
        titleLabel.frame = CGRect(x: safe.left + 10, y: safe.top + 8, width: 168, height: 24)
        let db = doneButton.intrinsicContentSize
        doneButton.frame = CGRect(x: view.bounds.width - safe.right - db.width - 10,
                                  y: safe.top + 8, width: db.width, height: 24)
        diagLabel.frame = CGRect(x: safe.left + 10,
                                 y: view.bounds.height - safe.bottom - 76,
                                 width: view.bounds.width - safe.left - safe.right - 20,
                                 height: 68)
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
        fitZoom = SpikeGeom.leafletFitZoom(viewport: size)
        scrollView.minimumZoomScale = CGFloat(pow(2.0, Double(SpikeGeom.minMapZoom - SpikeGeom.refZoom)))
        scrollView.maximumZoomScale = 1.0
        tiledView.level = fitZoom
        let scale = CGFloat(pow(2.0, Double(fitZoom - SpikeGeom.refZoom)))
        applyingFit = true
        scrollView.zoomScale = scale
        applyingFit = false
        centerOnResortBounds(scale: scale)
        refreshDiagnostics()
        // Tiles paint asynchronously; re-read once they have landed so
        // the "drawn" figure reflects the settled first paint.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.refreshDiagnostics()
        }
    }

    private func centerOnResortBounds(scale: CGFloat) {
        let cLat = (SpikeGeom.boundsSW.lat + SpikeGeom.boundsNE.lat) / 2.0
        let cLng = (SpikeGeom.boundsSW.lng + SpikeGeom.boundsNE.lng) / 2.0
        let c = SpikeGeom.globalPx(lat: cLat, lng: cLng)
        let localX = Double(c.x - tiledView.originGlobal.x)
        let localY = Double(c.y - tiledView.originGlobal.y)
        let vp = scrollView.bounds.size
        let cw = Double(scrollView.contentSize.width) * Double(scale)
        let ch = Double(scrollView.contentSize.height) * Double(scale)
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
        return tiledView
    }
    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        if !applyingFit { userInteracted = true }
        let z = 19.0 + log2(Double(scrollView.zoomScale))
        let l = Int(min(Double(SpikeGeom.maxMapZoom),
                        max(Double(SpikeGeom.minMapZoom), z.rounded())))
        if l != tiledView.level { tiledView.level = l }
    }
    private func settleRepaint() {
        tiledView.setNeedsDisplay()
        refreshDiagnostics()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.refreshDiagnostics()
        }
    }
    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
        settleRepaint()
    }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { settleRepaint() }
    }
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        settleRepaint()
    }

    // MARK: diagnostics (msg 142: in-process readout, from the start)

    private func refreshDiagnostics() {
        let s = Double(scrollView.zoomScale)
        guard s > 0 else { return }
        var vis = CGRect(x: Double(scrollView.contentOffset.x) / s,
                         y: Double(scrollView.contentOffset.y) / s,
                         width: Double(scrollView.bounds.width) / s,
                         height: Double(scrollView.bounds.height) / s)
        vis = vis.intersection(tiledView.bounds)
        var inView = 0, exact = 0, subst = 0, missing = 0, unpainted = 0
        if !vis.isNull && !vis.isEmpty {
            let span = 256.0 * pow(2.0, Double(SpikeGeom.refZoom - tiledView.level))
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
                        let res = tiledView.resolution(z: tiledView.level - 1, x: tx, y: ty)
                        switch res {
                        case 0: exact += 1
                        case 1: subst += 1
                        default: missing += 1
                        }
                        if res != 2 && !tiledView.wasPainted(level: tiledView.level, x: tx, y: ty) {
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
            format: " fit zoom %d · zoom %.2f · drawn %d\n tiles in view %d — exact %d · substituted %d · missing %d\n pack %@ · %@\n sv %.0fx%.0f · off (%.0f,%.0f) · inset t%.0f l%.0f b%.0f r%.0f",
            fitZoom, zoomNow, tiledView.drawnExact,
            inView, exact, subst, missing,
            packTileCount > 0 ? "\(packTileCount) tiles" : "size unknown",
            tilesStatus + (unpainted > 0 ? " · unpainted \(unpainted)" : ""),
            bo.width, bo.height, of.x, of.y, ci.top, ci.left, ci.bottom, ci.right)
    }

    func diagnosticsSnapshot() -> [String: Any] {
        refreshDiagnostics()
        return [
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
        CAPPluginMethod(name: "present", returnType: CAPPluginReturnPromise)
    ]

    private var spikeVC: SpikeViewController?
    private var pendingCall: CAPPluginCall?

    @objc func present(_ call: CAPPluginCall) {
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
            host.present(vc, animated: true)
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
