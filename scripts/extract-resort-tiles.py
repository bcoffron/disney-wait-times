#!/usr/bin/env python3
"""Extract the resort tile pack to on-disk PNG files (Claude msg 142, Q2).

The web map ships its resort tiles as a base64 dictionary in
park-tiles-resort.js (window.TPCP_TILES_RESORT, keys "z/x/y" in the web
layer's keyspace: key = Leaflet coords.z + zoomOffset(-1) at tileSize 256,
i.e. each key names a standard 256px slippy tile at zoom z+1). The native
map surface (msg 142 step 1+) reads plain PNG files from the app bundle
instead -- no base64 inflation, no in-memory JS dict.

Usage:
    python3 scripts/extract-resort-tiles.py [pack.js] [outdir]

Defaults: pack = ./park-tiles-resort.js, outdir = ./tiles
Output:  outdir/resort/<z>/<x>/<y>.png  (file bytes = the exact PNG bytes
         the pack's base64 decodes to -- nothing is re-encoded)
         outdir/manifest.json           (counts, bytes, per-zoom inventory)

Proof built in: every extracted file is re-decoded after writing and its
pixels (mode, size, palette, raw index bytes) are compared against a
decode of the pack value it came from. Any mismatch aborts nonzero.
Requires: Python 3 + Pillow.
"""
import base64
import io
import json
import os
import re
import sys

from PIL import Image


def main() -> int:
    pack_path = sys.argv[1] if len(sys.argv) > 1 else "park-tiles-resort.js"
    outdir = sys.argv[2] if len(sys.argv) > 2 else "tiles"

    src = open(pack_path, "r", encoding="utf-8").read()
    pack_bytes = len(src.encode("utf-8"))
    obj = src[src.index("{"): src.rindex("}") + 1]
    tiles = json.loads(obj)

    key_re = re.compile(r"^\d+/\d+/\d+$")
    per_zoom = {}
    total_png_bytes = 0
    verified = 0

    for key in sorted(tiles):
        if not key_re.match(key):
            print(f"FATAL: unexpected key shape: {key!r}")
            return 1
        z, x, y = key.split("/")
        png = base64.b64decode(tiles[key])

        # Decode the pack value (the reference pixels).
        ref = Image.open(io.BytesIO(png))
        ref.load()
        ref_sig = (ref.mode, ref.size, ref.tobytes(),
                   bytes(ref.getpalette() or []))

        dest = os.path.join(outdir, "resort", z, x, y + ".png")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as fh:
            fh.write(png)

        # Re-decode the written file and compare pixel-for-pixel.
        got = Image.open(dest)
        got.load()
        got_sig = (got.mode, got.size, got.tobytes(),
                   bytes(got.getpalette() or []))
        if got_sig != ref_sig:
            print(f"FATAL: pixel mismatch after write: {key}")
            return 1
        verified += 1

        total_png_bytes += len(png)
        slot = per_zoom.setdefault(z, {"count": 0, "bytes": 0})
        slot["count"] += 1
        slot["bytes"] += len(png)

    manifest = {
        "generatedBy": "scripts/extract-resort-tiles.py",
        "sourceFile": os.path.basename(pack_path),
        "keying": ("park-tiles-resort.js dict keys verbatim: z/x/y where "
                   "z = web layer coords.z + zoomOffset(-1) at tileSize 256 "
                   "(Claude msg 136 re-key); ancestor ladder walks z-1/z-2 "
                   "with x,y halved (floor) per step, as in createTile."),
        "layout": "tiles/resort/<z>/<x>/<y>.png",
        "keyCount": len(tiles),
        "totalPngBytes": total_png_bytes,
        "packJsBytes": pack_bytes,
        "perZoom": per_zoom,
        "pixelProof": (f"all {verified} extracted PNGs re-decoded and "
                       "verified pixel-identical (mode, size, palette, "
                       "index bytes) to the pack values they came from"),
    }
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "manifest.json"), "w",
              encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1, sort_keys=True)

    print(f"keys: {len(tiles)}  verified pixel-identical: {verified}")
    print(f"total PNG bytes: {total_png_bytes:,}")
    print(f"pack JS bytes:   {pack_bytes:,}  "
          f"(base64 overhead removed: {pack_bytes - total_png_bytes:,} bytes, "
          f"{100.0 * (pack_bytes - total_png_bytes) / pack_bytes:.1f}%)")
    for z in sorted(per_zoom, key=int):
        s = per_zoom[z]
        print(f"  z{z}: {s['count']} tiles, {s['bytes']:,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
