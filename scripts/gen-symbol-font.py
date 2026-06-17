#!/usr/bin/env python3
"""
Generate `src/renderer/fonts/operator-symbols.ttf` — a tiny monochrome, monospace-width
symbol font that supplies the glyphs the terminal font stack has no monochrome home for.

Why this exists
---------------
Claude Code's TUI draws its tool/status markers with Misc-Technical codepoints:
  ⏺ U+23FA (record bullet), ⏸ U+23F8 (pause / plan mode), ⎿ U+23BF (tree branch), …
A cmap scan of every font on macOS shows these exist ONLY in Apple Color Emoji (colour,
double-width → misaligns the grid) and LastResort.otf (the system "tofu" box). With
`font-variant-emoji: text` set on the terminal, WebKit refuses the colour emoji and, with
no text glyph anywhere in the stack, falls through to LastResort → the tofu boxes the user
sees. The dingbats/geometric markers (● ◆ ▸ ✔ ✦ ✻) are already covered by Menlo and are
fine — only the Misc-Technical block has no monochrome source.

Fix: bundle a font that supplies those glyphs as single-width text, placed FIRST in the
stack. Source = STIX Two Math, which ships with macOS and is SIL OFL 1.1 (redistributable)
and is confirmed to contain ⏺ ⏸ ⎿ plus the rest of the technical block.

This script is for reproducibility — the generated .ttf is committed to the repo, so CI
and release builds need neither Python nor network. Re-run it only to regenerate.

Usage: python3 scripts/gen-symbol-font.py
Requires: fontTools (already present in the environment).
"""
import os
import sys

from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options

SRC = "/System/Library/Fonts/Supplemental/STIXTwoMath.otf"
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "src", "renderer", "fonts")
OUT = os.path.normpath(os.path.join(OUT_DIR, "operator-symbols.woff2"))

FAMILY = "Operator Symbols"

# Blocks STIX covers that risk tofu/colour-emoji in the terminal. Broad on purpose so
# future Claude Code markers in these ranges won't tofu either.
#
# DELIBERATELY EXCLUDED: Box Drawing (U+2500–U+257F) and Block Elements (U+2580–U+259F).
# This font is FIRST in the stack, so anything it contains wins — and SF Mono draws the
# continuous box borders better than a proportional math font normalised to one width.
# Leaving those out keeps Claude Code's input box / rule borders seamless.
RANGES = [
    (0x2190, 0x21FF),  # Arrows
    (0x2300, 0x23FF),  # Misc Technical — ⏺ U+23FA, ⏸ U+23F8, ⎿ U+23BF, media controls
    (0x25A0, 0x25FF),  # Geometric Shapes — ● ◆ ▸ ▪ ▰ …
    (0x2600, 0x26FF),  # Misc Symbols — ⚠ ☰ ⚙ … (many are emoji-default → would tofu)
    (0x2700, 0x27BF),  # Dingbats — ✔ ✦ ✻ ✗ …
    (0x27F0, 0x27FF),  # Supplemental Arrows-A
    (0x2900, 0x297F),  # Supplemental Arrows-B
    (0x2B00, 0x2BFF),  # Misc Symbols and Arrows — ⬆ ⬡ ★ …
]

# Glyphs we must confirm made it into the output (the whole point of the font).
MUST_HAVE = {0x23FA: "⏺ record", 0x23F8: "⏸ pause", 0x23BF: "⎿ tree"}


def main() -> int:
    if not os.path.exists(SRC):
        print(f"ERROR: source font not found: {SRC}", file=sys.stderr)
        print("STIX Two Math ships with macOS; on other platforms point SRC at an "
              "OFL copy of STIXTwoMath.otf.", file=sys.stderr)
        return 1

    font = TTFont(SRC)
    src_cmap = font.getBestCmap()
    upem = font["head"].unitsPerEm

    # Codepoints in our ranges that the source actually has.
    wanted = sorted(
        cp for cp in src_cmap
        if any(lo <= cp <= hi for lo, hi in RANGES)
    )
    if not wanted:
        print("ERROR: source font covers none of the target ranges.", file=sys.stderr)
        return 1

    # Trim to just those glyphs.
    opts = Options()
    opts.glyph_names = False
    opts.recalc_bounds = True
    opts.notdef_outline = True
    opts.name_IDs = ["*"]
    opts.name_legacy = True
    opts.recommended_glyphs = True
    # Math/layout tables are irrelevant for a fallback glyph font and bloat the file.
    opts.layout_features = []
    opts.drop_tables += ["MATH", "GPOS", "GSUB", "GDEF", "DSIG"]
    sub = Subsetter(options=opts)
    sub.populate(unicodes=wanted)
    sub.subset(font)

    # Normalize to monospace: STIX is proportional, so rewrite every glyph's advance to
    # one uniform width (~0.6 em, the usual mono advance/em ratio). xterm sizes its cells
    # from the PRIMARY font (SF Mono); this just keeps these fallback glyphs from
    # overflowing into the neighbouring cell.
    adv = round(upem * 0.6)
    hmtx = font["hmtx"]
    for name in hmtx.metrics:
        _, lsb = hmtx.metrics[name]
        hmtx.metrics[name] = (adv, lsb)
    font["hhea"].advanceWidthMax = adv

    # Rename so it can't collide with anything the user has installed.
    name_tbl = font["name"]
    for nid in (1, 3, 4, 6, 16):
        name_tbl.setName(FAMILY if nid in (1, 16) else
                         (FAMILY if nid == 4 else
                          FAMILY.replace(" ", "") if nid == 6 else
                          FAMILY), nid, 3, 1, 0x409)
    name_tbl.setName(FAMILY, 1, 3, 1, 0x409)
    name_tbl.setName("Regular", 2, 3, 1, 0x409)
    name_tbl.setName(FAMILY, 4, 3, 1, 0x409)
    name_tbl.setName("OperatorSymbols-Regular", 6, 3, 1, 0x409)

    os.makedirs(OUT_DIR, exist_ok=True)
    font.flavor = "woff2"  # brotli-compressed; ~half the size of raw ttf
    font.save(OUT)

    # Verify coverage of the must-have glyphs in the OUTPUT.
    out_cmap = TTFont(OUT).getBestCmap()
    missing = [f"U+{cp:04X} {label}" for cp, label in MUST_HAVE.items() if cp not in out_cmap]
    size_kb = os.path.getsize(OUT) / 1024

    print(f"Wrote {OUT}  ({size_kb:.1f} KB, {len(out_cmap)} glyphs, advance={adv}/{upem} em)")
    if missing:
        print("ERROR: output is missing required glyphs: " + ", ".join(missing), file=sys.stderr)
        return 1
    have = ", ".join(f"U+{cp:04X} {label}" for cp, label in MUST_HAVE.items())
    print(f"OK: required glyphs present -> {have}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
