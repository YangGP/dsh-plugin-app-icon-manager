# Convert an uploaded raster image into a multi-size Windows .ico.
#
# Contract with lib/image-to-ico.js:
#   env DSH_ICO_REQUEST = path to a JSON file  { "source": ..., "target": ..., "sizes": [...] }
#   env DSH_ICO_RESULT  = path to write JSON    { "ok": bool, "width": int, "height": int,
#                                                 "bytes": int, "sizes": [...], "error": string }
#
# Input/output go through files rather than stdio: piped stdio is blocked under the DSH
# file sandbox (spawnSync returns EPERM), while file channels are not.
#
# This file MUST stay pure ASCII. Windows PowerShell is not involved, but Python's default
# source encoding on Windows is UTF-8 only for .py read by 3.x -- keeping it ASCII avoids
# any doubt and mirrors lib/shortcut.ps1's rule.

import json
import os
import struct
import sys

DEFAULT_SIZES = (16, 24, 32, 48, 64, 128, 256)


def fail(result_path, message):
    with open(result_path, "w", encoding="utf-8") as handle:
        json.dump({"ok": False, "error": message}, handle)
    sys.exit(0)


def main():
    request_path = os.environ.get("DSH_ICO_REQUEST", "")
    result_path = os.environ.get("DSH_ICO_RESULT", "")
    if not request_path or not result_path:
        print("missing DSH_ICO_REQUEST / DSH_ICO_RESULT", file=sys.stderr)
        sys.exit(2)

    with open(request_path, "r", encoding="utf-8") as handle:
        request = json.load(handle)

    source = request.get("source", "")
    target = request.get("target", "")
    raw_sizes = request.get("sizes") or list(DEFAULT_SIZES)
    try:
        sizes = sorted({int(size) for size in raw_sizes if int(size) > 0})
    except (TypeError, ValueError):
        sizes = list(DEFAULT_SIZES)
    if not sizes:
        sizes = list(DEFAULT_SIZES)

    try:
        from PIL import Image, ImageOps
    except ImportError as error:
        fail(result_path, "Pillow is not available: %s" % error)

    try:
        with Image.open(source) as opened:
            image = ImageOps.exif_transpose(opened)
            image.load()
            width, height = image.size
            image = image.convert("RGBA")

            # Non-square sources are centred on a transparent square canvas instead of being
            # stretched -- stretching would visibly distort the icon.
            if width != height:
                side = max(width, height)
                canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
                canvas.paste(image, ((side - width) // 2, (side - height) // 2))
                image = canvas

            # Only offer sizes the source can actually fill, but always keep one entry.
            longest = max(width, height)
            usable = tuple(size for size in sizes if size <= longest)
            if not usable:
                usable = (sizes[0],)

            image.save(
                target,
                format="ICO",
                sizes=[(size, size) for size in usable],
                bitmap_format="png",
            )
    except Exception as error:  # noqa: BLE001 - report any decoder/encoder failure to the caller
        fail(result_path, "%s: %s" % (type(error).__name__, error))

    # Verify what we produced instead of trusting the encoder.
    try:
        with open(target, "rb") as handle:
            data = handle.read()
        reserved, kind, count = struct.unpack("<HHH", data[:6])
        if data[:4] != b"\x00\x00\x01\x00":
            fail(result_path, "produced file is not an ICO (bad magic)")
        entries = []
        for index in range(count):
            offset = 6 + index * 16
            entry_width = data[offset] or 256
            entry_height = data[offset + 1] or 256
            entries.append([entry_width, entry_height])
    except Exception as error:  # noqa: BLE001
        fail(result_path, "verification failed: %s" % error)

    with open(result_path, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "ok": True,
                "width": width,
                "height": height,
                "bytes": len(data),
                "sizes": entries,
            },
            handle,
        )


if __name__ == "__main__":
    main()
