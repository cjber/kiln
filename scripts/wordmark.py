#!/usr/bin/env python3
"""Regenerate the wordmark for the README and the site header: kiln in Liberation Sans, with the
dot of the i drawn as an ember in the icon's colours.

The ember is not a second drawing of the letter: the i is outlined as dotless, and the ember fills
the box the font gives the missing dot.
"""

from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONT = Path("/usr/share/fonts/liberation/LiberationSans-Bold.ttf")
INK = "#101214"
PAPER = "#f4f1ec"
EMBER, FLAME = "#df8b63", "#ffc477"
SIZE = 74
BASELINE = 77
TRACKING = -2
MARGIN = 10
TOP = 8
HEIGHT = 80
OUT = Path(__file__).resolve().parent.parent / "assets"
SITE = Path(__file__).resolve().parent.parent / "site"

FONT_DATA = TTFont(FONT)
GLYPHS = FONT_DATA.getGlyphSet()
CMAP = FONT_DATA.getBestCmap()
SCALE = SIZE / FONT_DATA["head"].unitsPerEm


def outline(char: str, x: float) -> tuple[str, float]:
    glyph = CMAP[ord(char)]
    pen = SVGPathPen(GLYPHS)
    GLYPHS[glyph].draw(TransformPen(pen, (SCALE, 0, 0, -SCALE, x, BASELINE)))
    return pen.getCommands(), GLYPHS[glyph].width * SCALE


def dot_box(x: float) -> tuple[float, float, float, float]:
    """The box the i glyph gives its dot, in SVG coordinates."""
    glyph = FONT_DATA["glyf"][CMAP[ord("i")]]
    coords, ends, _ = glyph.getCoordinates(FONT_DATA["glyf"])
    start, boxes = 0, []
    for end in ends:
        points = coords[start : end + 1]
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        boxes.append((min(xs), min(ys), max(xs), max(ys)))
        start = end + 1
    dx0, dy0, dx1, dy1 = max(boxes, key=lambda box: box[3])
    return x + dx0 * SCALE, BASELINE - dy1 * SCALE, (dx1 - dx0) * SCALE, (dy1 - dy0) * SCALE


def ember(x: float) -> str:
    """A flame standing where the i's dot would be, in the icon's ember and flame colours."""
    left, top, width, height = dot_box(x)
    bx = left - width * 0.12
    bw = width * 1.24
    bh = height * 1.75
    by = top + height - bh

    def point(px: float, py: float) -> str:
        return f"{bx + px * bw:.2f} {by + py * bh:.2f}"

    def curve(points: list[tuple[float, float]]) -> str:
        return "C" + " ".join(point(px, py) for px, py in points)

    outer = "M" + point(0.5, 0)
    outer += curve([(0.58, 0.14), (0.82, 0.3), (0.82, 0.6)])
    outer += curve([(0.82, 0.83), (0.68, 1), (0.5, 1)])
    outer += curve([(0.32, 1), (0.18, 0.83), (0.18, 0.6)])
    outer += curve([(0.18, 0.42), (0.28, 0.32), (0.35, 0.18)])
    outer += curve([(0.38, 0.28), (0.44, 0.36), (0.5, 0.4)])
    outer += curve([(0.47, 0.28), (0.47, 0.12), (0.5, 0)]) + "Z"

    inner = "M" + point(0.5, 0.42)
    inner += curve([(0.58, 0.52), (0.66, 0.62), (0.66, 0.74)])
    inner += curve([(0.66, 0.86), (0.59, 0.93), (0.5, 0.93)])
    inner += curve([(0.41, 0.93), (0.34, 0.86), (0.34, 0.74)])
    inner += curve([(0.34, 0.66), (0.4, 0.58), (0.5, 0.42)]) + "Z"

    return f'<path d="{outer}" fill="{EMBER}"/><path d="{inner}" fill="{FLAME}"/>'


def wordmark(ink: str) -> str:
    x, parts = float(MARGIN), []
    for char in "kiln":
        glyph = "ı" if char == "i" else char
        path, advance = outline(glyph, x)
        parts.append(f'<path d="{path}" fill="{ink}"/>')
        if char == "i":
            parts.append(ember(x))
        x += advance + TRACKING

    width = x - TRACKING + MARGIN
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 {TOP} {width:.2f} {HEIGHT}" role="img" '
        f'aria-label="kiln"><title>kiln</title>{"".join(parts)}</svg>\n'
    )


for directory in (OUT, SITE):
    (directory / "wordmark.svg").write_text(wordmark(INK))
    (directory / "wordmark-dark.svg").write_text(wordmark(PAPER))
