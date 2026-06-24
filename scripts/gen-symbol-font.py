#!/usr/bin/env python3
"""
Generate the two bundled monochrome symbol fonts the terminal needs:

  src/renderer/fonts/operator-symbols.woff2  — from STIX Two Math (on macOS, SIL OFL).
      Supplies the Misc-Technical / geometric / dingbat / arrow markers Claude Code draws
      (⏺ U+23FA tool bullet, ⏸ U+23F8, ⎿ U+23BF tree, …) which exist on macOS ONLY in
      Apple Color Emoji (colour, double-width) and LastResort.otf (the "tofu" box).

  src/renderer/fonts/operator-legacy.woff2   — from GNU Unifont (OFL/GPL+exception).
      Supplies "Symbols for Legacy Computing" (U+1FB00–1FBFF) + Supplement (U+1CC00–1CEBF),
      the block-mosaic glyphs Claude Code's logo/art uses. A binary scan of the Claude Code
      CLI found e.g. U+1FB82 U+1FB90 U+1FBE0 U+1FBF0 U+1CD49 U+1CD6D — and NO macOS font but
      LastResort has these blocks, so they tofu intermittently (whenever the art draws one).

  src/renderer/fonts/operator-emoji.woff2    — from GNU Unifont (OFL/GPL+exception).
      Monochrome glyphs for the DOUBLE-WIDTH emoji-pictographs Claude Code draws as
      composer ornaments (👣 U+1F463 footprints, centred on the input divider). These have
      no text-presentation form, so `font-variant-emoji: text` (which we set on .xterm to
      keep status markers monochrome) degrades them to a grey LastResort/colour-emoji box.
      Unlike the legacy mosaics these occupy two cells, so they get their OWN font (natural
      double-width advance), kept separate from the single-width 'operator-legacy' subset.

Both are listed first in the terminal font stack (see TerminalPane.tsx / styles.css). They
carry no letter glyphs, so SF Mono still wins for text. Braille (U+28xx, also heavily used
by Claude Code) is NOT bundled — 'Apple Symbols' is in the stack and is the only system
font that has it.

The generated .woff2 files are committed, so CI/release builds need neither Python nor
network. Re-run this only to regenerate (it will fetch Unifont into /tmp if missing).

Usage: python3 scripts/gen-symbol-font.py
Requires: fontTools + brotli (already present in the environment).
"""
import os
import sys
import urllib.request

from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options

OUT_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "src", "renderer", "fonts"))

# --- source 1: STIX Two Math (ships with macOS) -----------------------------------------
STIX_SRC = "/System/Library/Fonts/Supplemental/STIXTwoMath.otf"
# Blocks STIX covers that risk tofu/colour-emoji. Broad on purpose so future markers in
# these ranges won't tofu. DELIBERATELY EXCLUDES Box Drawing (U+2500–U+257F) + Block
# Elements (U+2580–U+259F): this font is first in the stack, and SF Mono draws the
# continuous box/rule borders better than a proportional math font normalised to one width.
STIX_RANGES = [
    (0x2190, 0x21FF),  # Arrows
    (0x2300, 0x23FF),  # Misc Technical — ⏺ U+23FA, ⏸ U+23F8, ⎿ U+23BF, media controls
    (0x25A0, 0x25FF),  # Geometric Shapes — ● ◆ ▸ ▪ ▰ …
    (0x2600, 0x26FF),  # Misc Symbols
    (0x2700, 0x27BF),  # Dingbats — ✔ ✦ ✻ ✗ …
    (0x27F0, 0x27FF),  # Supplemental Arrows-A
    (0x2900, 0x297F),  # Supplemental Arrows-B
    (0x2B00, 0x2BFF),  # Misc Symbols and Arrows
]
STIX_MUST = {0x23FA: "⏺ record", 0x23F8: "⏸ pause", 0x23BF: "⎿ tree"}

# --- source 2: GNU Unifont upper plane (fetched) ----------------------------------------
UNIFONT_VER = "16.0.04"
UNIFONT_URL = (f"https://unifoundry.com/pub/unifont/unifont-{UNIFONT_VER}/"
               f"font-builds/unifont_upper-{UNIFONT_VER}.otf")
UNIFONT_CACHE = f"/tmp/unifont_upper-{UNIFONT_VER}.otf"
LEGACY_RANGES = [
    (0x1FB00, 0x1FBFF),  # Symbols for Legacy Computing
    (0x1CC00, 0x1CEBF),  # Symbols for Legacy Computing Supplement (Unicode 16)
]
LEGACY_MUST = {0x1FB82: "🮂", 0x1FB90: "🮐", 0x1FBE0: "🯠", 0x1FBF0: "🯰",
               0x1CD49: "𜵉", 0x1CD6D: "𜵭"}

# --- source 3: GNU Unifont — double-width emoji-pictograph ornaments ---------------------
# Tight list (NOT a broad range) so the woff2 stays tiny and we don't override OTHER emoji
# with Unifont's crude monochrome forms. Add codepoints here if new composer ornaments tofu.
EMOJI_RANGES = [(0x1F463, 0x1F463)]  # 👣 footprints — Claude Code's composer-divider ornament
EMOJI_MUST = {0x1F463: "👣 footprints"}

# --- source 4: GNU Unifont (BMP) — single-width dingbat / symbol ornaments ----------------
# STIX (operator-symbols) is first in the stack and covers MOST of these blocks, but it has
# GAPS — notably the EMOJI-PRESENTATION dingbats Claude Code draws as welcome-box ornaments
# (✳ U+2733 sparkle studs on the box frame, ✔ U+2714, ✖ U+2716, ✨ U+2728, …). Those tofu
# because `font-variant-emoji: text` (set on .xterm) forces text presentation, and the only
# system font with a text glyph (Menlo) is reached via the emoji-text FALLBACK path, which
# skips it → LastResort box. A SYSTEM font can't win that race, but a bundled @font-face one
# CAN (proven: operator-emoji renders 👣 from 3rd in the stack). So we ship a Unifont subset
# of the symbol blocks and list it AFTER operator-symbols — STIX still wins for the codepoints
# it has (nicer glyphs), Unifont only fills STIX's gaps. Broad ranges on purpose so future
# ornaments in these blocks don't tofu; overlap with STIX is harmless (STIX is earlier).
UNIFONT_BMP_URL = (f"https://unifoundry.com/pub/unifont/unifont-{UNIFONT_VER}/"
                   f"font-builds/unifont-{UNIFONT_VER}.otf")
UNIFONT_BMP_CACHE = f"/tmp/unifont-{UNIFONT_VER}.otf"
DINGBAT_RANGES = [
    (0x2600, 0x26FF),  # Misc Symbols — ☀ ⚙ ⚠ ☢ ♠ ♥ …
    (0x2700, 0x27BF),  # Dingbats — ✳ ✔ ✖ ✦ ✻ ✗ ❯ … (STIX has only a handful)
    (0x2B00, 0x2BFF),  # Misc Symbols & Arrows — ⭐ ⬆ ⬇ …
]
DINGBAT_MUST = {0x2733: "✳ sparkle stud", 0x2714: "✔ check", 0x2716: "✖ cross",
                0x2728: "✨ sparkles", 0x276F: "❯ chevron"}


def subset_font(src_path, ranges, family, ps_name, out_name, must_have, adv_ratio):
    """Subset `src_path` to `ranges`, normalise advances, rename, save as woff2, verify."""
    font = TTFont(src_path)
    cmap = font.getBestCmap()
    upem = font["head"].unitsPerEm
    wanted = sorted(cp for cp in cmap if any(lo <= cp <= hi for lo, hi in ranges))
    if not wanted:
        print(f"ERROR: {os.path.basename(src_path)} covers none of the target ranges.",
              file=sys.stderr)
        return 1

    opts = Options()
    opts.glyph_names = False
    opts.recalc_bounds = True
    opts.notdef_outline = True
    opts.name_IDs = ["*"]
    opts.name_legacy = True
    opts.recommended_glyphs = True
    opts.layout_features = []
    opts.drop_tables += ["MATH", "GPOS", "GSUB", "GDEF", "DSIG"]
    # Don't recalc OS/2 unicode/codepage ranges: Unifont sets the newest Unicode range
    # bit (123, Legacy Computing Supplement) which this fontTools version rejects (max 122).
    # The ranges are cosmetic metadata for a fallback font anyway.
    opts.prune_unicode_ranges = False
    opts.prune_codepage_ranges = False
    sub = Subsetter(options=opts)
    sub.populate(unicodes=wanted)
    sub.subset(font)

    # Normalise every glyph to one uniform single-cell advance. xterm sizes its cells from
    # the PRIMARY font (SF Mono); this just stops a fallback glyph overflowing its cell.
    adv = round(upem * adv_ratio)
    hmtx = font["hmtx"]
    for name in hmtx.metrics:
        _, lsb = hmtx.metrics[name]
        hmtx.metrics[name] = (adv, lsb)
    font["hhea"].advanceWidthMax = adv

    # Rename so it can't collide with an installed copy.
    name_tbl = font["name"]
    name_tbl.setName(family, 1, 3, 1, 0x409)
    name_tbl.setName("Regular", 2, 3, 1, 0x409)
    name_tbl.setName(family, 4, 3, 1, 0x409)
    name_tbl.setName(ps_name, 6, 3, 1, 0x409)

    out = os.path.join(OUT_DIR, out_name)
    os.makedirs(OUT_DIR, exist_ok=True)
    font.flavor = "woff2"
    font.save(out)

    out_cmap = TTFont(out).getBestCmap()
    missing = [f"U+{cp:04X} {lbl}" for cp, lbl in must_have.items() if cp not in out_cmap]
    print(f"Wrote {out}  ({os.path.getsize(out) / 1024:.1f} KB, {len(out_cmap)} glyphs, "
          f"advance={adv}/{upem} em)")
    if missing:
        print("ERROR: output missing required glyphs: " + ", ".join(missing), file=sys.stderr)
        return 1
    print("OK: required glyphs present -> " + ", ".join(f"U+{cp:04X}{lbl}"
                                                        for cp, lbl in must_have.items()))
    return 0


def ensure_unifont():
    if not os.path.exists(UNIFONT_CACHE):
        print(f"Fetching Unifont {UNIFONT_VER} (one-time) -> {UNIFONT_CACHE}")
        urllib.request.urlretrieve(UNIFONT_URL, UNIFONT_CACHE)
    return UNIFONT_CACHE


def ensure_unifont_bmp():
    if not os.path.exists(UNIFONT_BMP_CACHE):
        print(f"Fetching Unifont BMP {UNIFONT_VER} (one-time) -> {UNIFONT_BMP_CACHE}")
        urllib.request.urlretrieve(UNIFONT_BMP_URL, UNIFONT_BMP_CACHE)
    return UNIFONT_BMP_CACHE


def main() -> int:
    if not os.path.exists(STIX_SRC):
        print(f"ERROR: STIX Two Math not found: {STIX_SRC} (ships with macOS).", file=sys.stderr)
        return 1
    rc = subset_font(STIX_SRC, STIX_RANGES, "Operator Symbols", "OperatorSymbols-Regular",
                     "operator-symbols.woff2", STIX_MUST, adv_ratio=0.6)
    if rc:
        return rc
    # Unifont legacy glyphs are single-width (advance 32 of a 64 em) and fill the cell;
    # keep that 0.5 ratio. @font-face size-adjust tunes the final visual fill.
    rc = subset_font(ensure_unifont(), LEGACY_RANGES, "Operator Legacy", "OperatorLegacy-Regular",
                     "operator-legacy.woff2", LEGACY_MUST, adv_ratio=0.5)
    if rc:
        return rc
    # Footprints & friends are DOUBLE-width (advance 64 of 64 em). Keep the full 1.0 ratio so
    # the glyph spans both cells; @font-face size-adjust matches the legacy fill (~2 cells).
    rc = subset_font(ensure_unifont(), EMOJI_RANGES, "Operator Emoji", "OperatorEmoji-Regular",
                     "operator-emoji.woff2", EMOJI_MUST, adv_ratio=1.0)
    if rc:
        return rc
    # Dingbat/symbol ornaments are single-width (advance 32 of a 64 em); keep the 0.5 ratio
    # like the legacy mosaics. @font-face size-adjust tunes the final visual fill.
    rc = subset_font(ensure_unifont_bmp(), DINGBAT_RANGES, "Operator Dingbats",
                     "OperatorDingbats-Regular", "operator-dingbats.woff2", DINGBAT_MUST,
                     adv_ratio=0.5)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
