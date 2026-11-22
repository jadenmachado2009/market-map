"""Build the Market Map brand assets (spec brand-1, "Maison" logo).

Every letter is outlined to SVG paths, so nothing depends on fonts at runtime.

Fonts (SIL Open Font License, from github.com/google/fonts):
  ofl/bodonimoda/BodoniModa[opsz,wght].ttf   -> the "MM" monogram
  ofl/geist/Geist[wght].ttf                  -> "MARKET MAP", the site's own sans

Usage (from the repo root):
  python brand/build_brand.py --fonts DIR_WITH_THE_TWO_TTFS

Writes web/public/brand/*.svg|png|ico, web/src/app/favicon.ico and web/src/brand/logo-paths.ts.
PNGs are rasterised with headless Chrome (a throwaway profile in a temp dir).
"""
from __future__ import annotations

import argparse
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
OFF_WHITE = "#f0efec"  # the site's dark-theme ink
BG = "#0e0e0e"
MUTED = "#9a998f"  # the site's dark-theme ink-3
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Type choices. Bodoni Moda's optical-size axis thickens hairlines at small sizes.
LOGO_BODONI = {"wght": 400, "opsz": 36}  # regular, high contrast: stacked lockups and link previews
HEADER_BODONI = {"wght": 400, "opsz": 14}  # regular, sturdier hairlines for the ~30 px header (crisp at 1x)
ICON_BODONI = {"wght": 600, "opsz": 6}  # favicon: semibold, sturdiest hairlines
WORD_GEIST = {"wght": 500}


def num(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


class Face:
    def __init__(self, path: Path, axes: dict):
        font = TTFont(path)
        self.font = instantiateVariableFont(font, axes)
        self.upm = self.font["head"].unitsPerEm
        self.cap = self.font["OS/2"].sCapHeight / self.upm
        self.cmap = self.font.getBestCmap()
        self.glyphs = self.font.getGlyphSet()
        self.hmtx = self.font["hmtx"]

    def advance(self, ch: str, size: float) -> float:
        return self.hmtx[self.cmap[ord(ch)]][0] / self.upm * size

    def ink_box(self, ch: str) -> tuple[float, float]:
        """Left and right ink edges of a glyph, in em."""
        g = self.font["glyf"][self.cmap[ord(ch)]]
        g.recalcBounds(self.font["glyf"])
        return getattr(g, "xMin", 0) / self.upm, getattr(g, "xMax", 0) / self.upm

    def width(self, text: str, size: float, tracking: float = 0.0) -> float:
        """Ink-to-ink width: advances plus tracking between letters, minus the side bearings at both ends."""
        adv = sum(self.advance(c, size) for c in text) + tracking * (len(text) - 1)
        first_l = self.ink_box(text[0])[0] * size
        last_adv = self.advance(text[-1], size)
        last_r = self.ink_box(text[-1])[1] * size
        return adv - first_l - (last_adv - last_r)

    def path(self, text: str, size: float, x: float, baseline: float, tracking: float = 0.0, anchor: str = "start") -> str:
        """SVG path data for `text`, ink-aligned at x (start) or centred on x (middle)."""
        w = self.width(text, size, tracking)
        left = x if anchor == "start" else x - w / 2
        pen_x = left - self.ink_box(text[0])[0] * size
        s = size / self.upm
        out = []
        for ch in text:
            if ch != " ":
                pen = SVGPathPen(self.glyphs, ntos=num)
                self.glyphs[self.cmap[ord(ch)]].draw(TransformPen(pen, (s, 0, 0, -s, pen_x, baseline)))
                out.append(pen.getCommands())
            pen_x += self.advance(ch, size) + tracking
        return "".join(out)


def svg(w: float, h: float, body: str, view: str | None = None, label: str | None = None) -> str:
    aria = f' role="img" aria-label="{label}"' if label else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view or f"0 0 {num(w)} {num(h)}"}" '
        f'width="{num(w)}" height="{num(h)}"{aria}>{body}</svg>\n'
    )


# ----------------------------------------------------------------------------- the lockups

def stacked(bodoni: Face, geist: Face, pro: bool) -> dict:
    """Spec proportions, viewBox 0 0 100 80: MM baseline 34 @16; rule 40-60 @42; wordmark baseline 58 @7.5, tracking 3.2."""
    word = "MARKET MAP · PRO" if pro else "MARKET MAP"
    w = 100 if not pro else max(100, geist.width(word, 7.5, 3.2) + 12)
    cx = w / 2
    return {
        "w": w, "h": 80,
        "mm": bodoni.path("MM", 16, cx, 34, anchor="middle"),
        "rule": (cx - 10, 42, cx + 10, 42, 0.6),
        "word": geist.path(word, 7.5, cx, 58, 3.2, anchor="middle"),
        "top": 34 - bodoni.cap * 16,
        "bottom": 58,
    }


def horizontal(bodoni: Face, geist: Face, pro: bool) -> dict:
    """MM | MARKET MAP, drawn at 32 units tall = 32 px in the desktop header."""
    H = 32.0
    mm_size = 30 / bodoni.cap  # MM cap height 30, 1 unit of air above and below
    mm_w = bodoni.width("MM", mm_size)
    gap = 11.0
    rule_x = mm_w + gap
    word_size = 11 / geist.cap  # wordmark caps 11 units tall
    tracking = 0.4 * word_size
    word_x = rule_x + gap
    word = "MARKET MAP · PRO" if pro else "MARKET MAP"
    w = word_x + geist.width(word, word_size, tracking)
    return {
        "w": w, "h": H,
        "mm": bodoni.path("MM", mm_size, 0, 31),
        "rule": (rule_x, 6, rule_x, 26, 1.0),
        "word": geist.path(word, word_size, word_x, H / 2 + 5.5, tracking),
    }


def lockup_svg(L: dict, fill: str, label: str, view: str | None = None, extra: str = "") -> str:
    x1, y1, x2, y2, sw = L["rule"]
    body = (
        f'<g fill="{fill}"><path d="{L["mm"]}"/><path d="{L["word"]}"/></g>'
        f'<line x1="{num(x1)}" y1="{num(y1)}" x2="{num(x2)}" y2="{num(y2)}" stroke="{fill}" stroke-width="{num(sw)}" stroke-opacity="0.6"/>'
    )
    return svg(L["w"], L["h"], extra + body, view, label)


def icon_svg(bodoni: Face, size: int, rounded: bool) -> str:
    fs = 26 / bodoni.width("MM", 1)  # MM ink 26 units wide in a 32-unit square
    base = 16 + bodoni.cap * fs / 2
    d = bodoni.path("MM", fs, 16, base, anchor="middle")
    rx = 5 if rounded else 0
    body = f'<rect width="32" height="32" rx="{rx}" fill="{BG}"/><path fill="{OFF_WHITE}" d="{d}"/>'
    return svg(size, size, body, "0 0 32 32")


def og_svg(bodoni: Face, geist: Face, pro: bool, tagline: str) -> str:
    L = stacked(bodoni, geist, pro)
    s = 6.0
    content_h = (L["bottom"] - L["top"]) * s
    tag_size = 34.0
    gap = 64.0
    total = content_h + gap + geist.cap * tag_size
    top = (630 - total) / 2
    tx = 600 - L["w"] * s / 2
    ty = top - L["top"] * s
    tag_base = top + content_h + gap + geist.cap * tag_size
    tag = geist_regular_path(tagline, tag_size, 600, tag_base)
    x1, y1, x2, y2, sw = L["rule"]
    body = (
        f'<rect width="1200" height="630" fill="{BG}"/>'
        f'<g transform="translate({num(tx)} {num(ty)}) scale({num(s)})">'
        f'<g fill="{OFF_WHITE}"><path d="{L["mm"]}"/><path d="{L["word"]}"/></g>'
        f'<line x1="{num(x1)}" y1="{num(y1)}" x2="{num(x2)}" y2="{num(y2)}" stroke="{OFF_WHITE}" stroke-width="{num(sw)}" stroke-opacity="0.6"/></g>'
        f'<path fill="{MUTED}" d="{tag}"/>'
    )
    return svg(1200, 630, body)


GEIST_REGULAR: Face | None = None


def geist_regular_path(text: str, size: float, cx: float, base: float) -> str:
    return GEIST_REGULAR.path(text, size, cx, base, anchor="middle")


# ----------------------------------------------------------------------------- output

def raster(svg_path: Path, png_path: Path, w: int, h: int, tmp: Path) -> None:
    subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
         "--default-background-color=00000000", f"--user-data-dir={tmp / 'chrome'}", f"--window-size={w},{h}",
         f"--screenshot={png_path}", svg_path.as_uri()],
        check=True, capture_output=True,
    )


def write_ico(pngs: list[tuple[int, bytes]], path: Path) -> None:
    """ICO with PNG-compressed entries (supported by every current browser)."""
    head = struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    dirs, blobs = b"", b""
    for size, data in pngs:
        dirs += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    path.write_bytes(head + dirs + blobs)


def ts_module(h: dict, hp: dict) -> str:
    def obj(L):
        x1, y1, x2, y2, sw = L["rule"]
        return (
            f'{{\n  viewBox: "0 0 {num(L["w"])} {num(L["h"])}",\n  width: {num(L["w"])},\n  height: {num(L["h"])},\n'
            f'  mm: "{L["mm"]}",\n  word: "{L["word"]}",\n'
            f"  rule: {{ x1: {num(x1)}, y1: {num(y1)}, x2: {num(x2)}, y2: {num(y2)}, strokeWidth: {num(sw)} }},\n}}"
        )
    return (
        "// Generated by brand/build_brand.py. Do not edit by hand.\n"
        "// Outlined lettering for the horizontal Market Map lockups (Bodoni Moda \"MM\", Geist \"MARKET MAP\").\n"
        f"export const HORIZONTAL = {obj(h)};\n\nexport const HORIZONTAL_PRO = {obj(hp)};\n"
    )


def main() -> None:
    global GEIST_REGULAR
    ap = argparse.ArgumentParser()
    ap.add_argument("--fonts", required=True, type=Path)
    a = ap.parse_args()
    bodoni = Face(a.fonts / "BodoniModa.ttf", LOGO_BODONI)
    bodoni_header = Face(a.fonts / "BodoniModa.ttf", HEADER_BODONI)
    bodoni_icon = Face(a.fonts / "BodoniModa.ttf", ICON_BODONI)
    geist = Face(a.fonts / "Geist.ttf", WORD_GEIST)
    GEIST_REGULAR = Face(a.fonts / "Geist.ttf", {"wght": 400})

    out = WEB / "public" / "brand"
    out.mkdir(parents=True, exist_ok=True)
    (WEB / "src" / "brand").mkdir(parents=True, exist_ok=True)

    st, stp = stacked(bodoni, geist, False), stacked(bodoni, geist, True)
    h, hp = horizontal(bodoni_header, geist, False), horizontal(bodoni_header, geist, True)
    files = {
        "mm-lockup.svg": lockup_svg(st, OFF_WHITE, "Market Map"),
        "mm-lockup-pro.svg": lockup_svg(stp, OFF_WHITE, "Market Map Pro"),
        "mm-horizontal.svg": lockup_svg(h, OFF_WHITE, "Market Map"),
        "mm-horizontal-pro.svg": lockup_svg(hp, OFF_WHITE, "Market Map Pro"),
        "favicon.svg": icon_svg(bodoni_icon, 32, rounded=True),
    }
    for name, text in files.items():
        (out / name).write_text(text)
    (WEB / "src" / "brand" / "logo-paths.ts").write_text(ts_module(h, hp))

    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        jobs = {
            "og-classic": (og_svg(bodoni, geist, False, "Which stocks are secretly connected?"), 1200, 630),
            "og-pro": (og_svg(bodoni, geist, True, "See what your portfolio is really betting on."), 1200, 630),
            "apple-touch-icon": (icon_svg(bodoni_icon, 180, rounded=False), 180, 180),
            **{f"fav-{n}": (icon_svg(bodoni_icon, n, rounded=True), n, n) for n in (16, 32, 48)},
        }
        for name, (text, w, hgt) in jobs.items():
            src = tmp / f"{name}.svg"
            src.write_text(text)
            raster(src, tmp / f"{name}.png", w, hgt, tmp)
        for name in ("og-classic", "og-pro", "apple-touch-icon"):
            shutil.copy(tmp / f"{name}.png", out / f"{name}.png")
        write_ico([(n, (tmp / f"fav-{n}.png").read_bytes()) for n in (16, 32, 48)], out / "favicon.ico")
    shutil.copy(out / "favicon.ico", WEB / "src" / "app" / "favicon.ico")
    for p in sorted(out.iterdir()):
        print(f"{p.relative_to(ROOT)}  {p.stat().st_size:,} B")
    print(f"horizontal {num(h['w'])}x32, pro {num(hp['w'])}x32; stacked pro viewBox width {num(stp['w'])}")


if __name__ == "__main__":
    main()
