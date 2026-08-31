#!/usr/bin/env python3
"""
Generate 1200x630 Open Graph preview cards for each community solar site.

One card per site with the site's short display name in gold, plus a generic
"og.png" used as a fallback for any site without a dedicated image.

Output files are written to ../public/og-{slug}.png and ../public/og.png, where
{slug} is derived from the site's SITE_NAME env var using the same slugify
rule that server.js applies at runtime:
  - NFD-normalize + strip combining marks (Niños -> Ninos)
  - lowercase
  - non-alphanumerics -> single dash
  - trim leading/trailing dashes

Run from anywhere:
    python3 scripts/generate-og-images.py
"""

import os
import re
import sys
import unicodedata
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT   = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
LOGO   = PUBLIC / "logo.png"

# Canvas
W, H = 1200, 630
BG       = (3, 6, 9)          # matches dashboard --bg
GOLD     = (245, 179, 65)     # matches dashboard --gold
WHITE    = (237, 241, 255)    # matches dashboard --ink
MUTED    = (140, 150, 170)
GRID     = (255, 210, 120, 28)

# Fonts — DejaVu is present on most Linux distros (used by Pillow's default
# install path). Fall back to PIL default if missing.
FONT_DIRS = [
    "/usr/share/fonts/truetype/dejavu",
    "/Library/Fonts",
    "/System/Library/Fonts",
    os.path.expanduser("~/Library/Fonts"),
]

# macOS ships no DejaVu. Rather than silently degrade to PIL's bitmap default
# (which renders an unreadable card), pick up the copy matplotlib bundles if
# it happens to be installed: `pip install matplotlib`.
try:
    import matplotlib
    FONT_DIRS.append(os.path.join(matplotlib.get_data_path(), "fonts", "ttf"))
except Exception:
    pass

def _find_font(*candidates):
    for d in FONT_DIRS:
        for name in candidates:
            p = Path(d) / name
            if p.exists():
                return str(p)
    return None

FONT_BOLD    = _find_font("DejaVuSans-Bold.ttf", "Arial Bold.ttf")
FONT_REGULAR = _find_font("DejaVuSans.ttf", "Arial.ttf")

# Sites — tuples of (SITE_NAME env var value, display name for the card).
# SITE_NAME must match the Railway env var exactly so the slug matches at
# runtime. Display name is what gets painted in gold on the card.
SITES = [
    ("Cuidando Los Niños Community Solar",   "CUIDANDO LOS NIÑOS"),
    ("Central New Mexico Community Solar",   "CENTRAL NEW MEXICO"),
    ("Locker 505 Community Solar",           "LOCKER 505"),
    ("Global Give a Book Community Solar",   "GLOBAL GIVE A BOOK"),
    ("Wings for Life Community Solar",       "WINGS FOR LIFE"),
    ("WESST Community Solar",                "WESST"),
    ("Homewise Community Solar",             "HOMEWISE"),
]


def slugify(name: str) -> str:
    """Mirror of the slugify function in server.js."""
    # Strip combining marks (Niños -> Ninos)
    norm = unicodedata.normalize("NFD", name)
    norm = "".join(c for c in norm if not unicodedata.combining(c))
    s = norm.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s


def load_font(path, size):
    if path:
        return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_background(img: Image.Image):
    """Matte-black panel with subtle gold grid + a warm glow behind the logo."""
    draw = ImageDraw.Draw(img, "RGBA")

    # Big soft gold radial glow, brighter/bigger than before so the card feels
    # lit up rather than flat. Roughly centered behind the logo + headline.
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    cx, cy = W // 2, 310
    for r in range(520, 40, -24):
        # Peak alpha ~44 near center, tapers to 0 at edge.
        alpha = max(0, min(255, int(44 * (1 - r / 520))))
        gdraw.ellipse(
            [cx - r, cy - int(r * 0.72), cx + r, cy + int(r * 0.72)],
            fill=(255, 195, 90, alpha),
        )
    glow = glow.filter(ImageFilter.GaussianBlur(50))
    img.alpha_composite(glow)

    # Grid — draw on its own transparent layer so the RGBA alpha in GRID
    # is actually honored when we composite back (PIL's draw.line silently
    # ignores alpha on 1-pixel-wide lines, which would leave full-opacity
    # grid lines no matter what alpha we set).
    grid_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(grid_layer)
    cols, rows = 12, 7
    for i in range(1, cols):
        x = int(W * i / cols)
        gdraw.line([(x, 0), (x, H)], fill=GRID, width=1)
    for i in range(1, rows):
        y = int(H * i / rows)
        gdraw.line([(0, y), (W, y)], fill=GRID, width=1)
    img.alpha_composite(grid_layer)


def paste_logo(img: Image.Image, y: int = 80) -> int:
    """Paste the affordable solar logo centered horizontally; return y-bottom."""
    if not LOGO.exists():
        return y + 160
    logo = Image.open(LOGO).convert("RGBA")
    # Target width ~620px; preserve aspect ratio.
    target_w = 620
    ratio = target_w / logo.width
    target_h = int(logo.height * ratio)
    logo = logo.resize((target_w, target_h), Image.LANCZOS)
    x = (W - target_w) // 2
    img.alpha_composite(logo, (x, y))
    return y + target_h


def fit_text(text: str, font_path: str, max_width: int, max_size: int, min_size: int = 36):
    """Shrink `text` to fit within `max_width` pixels; return (font, width)."""
    size = max_size
    while size >= min_size:
        font = load_font(font_path, size)
        bbox = font.getbbox(text)
        w = bbox[2] - bbox[0]
        if w <= max_width:
            return font, w, size
        size -= 2
    font = load_font(font_path, min_size)
    bbox = font.getbbox(text)
    return font, bbox[2] - bbox[0], min_size


def draw_card(display_name: str, out_path: Path):
    img = Image.new("RGBA", (W, H), BG + (255,))
    draw_background(img)

    # Logo sits a bit lower than center-of-top so there's breathing room on top.
    logo_bottom = paste_logo(img, y=95)

    draw = ImageDraw.Draw(img)

    # Big gold headline — auto-size to fit. Target size matches the original
    # "COMMUNITY SOLAR" headline so WESST, WINGS FOR LIFE, and GLOBAL GIVE A
    # BOOK all land at a similar visual weight.
    headline = display_name.upper()
    head_font, head_w, _ = fit_text(
        headline, FONT_BOLD, max_width=1040, max_size=88, min_size=48,
    )
    head_y = logo_bottom + 34
    draw.text(((W - head_w) // 2, head_y), headline, fill=GOLD, font=head_font)
    head_h = head_font.getbbox(headline)[3] - head_font.getbbox(headline)[1]

    # Subtitle — keep the original phrasing ("Real-Time Production Dashboard")
    # so these cards read the same as the generic one Tyler liked.
    sub_font = load_font(FONT_REGULAR, 36)
    subtitle = "Real-Time Production Dashboard"
    sub_w = sub_font.getbbox(subtitle)[2] - sub_font.getbbox(subtitle)[0]
    sub_y = head_y + head_h + 26
    draw.text(((W - sub_w) // 2, sub_y), subtitle, fill=WHITE, font=sub_font)

    # Divider — short gold rule, same as original.
    divider_y = sub_y + 78
    draw.line(
        [(W // 2 - 90, divider_y), (W // 2 + 90, divider_y)],
        fill=GOLD, width=2,
    )

    # Footer — muted "AFFORDABLE SOLAR GROUP · NEW MEXICO"
    foot_font = load_font(FONT_BOLD, 22)
    footer = "AFFORDABLE SOLAR GROUP  ·  NEW MEXICO"
    foot_w = foot_font.getbbox(footer)[2] - foot_font.getbbox(footer)[0]
    draw.text(
        ((W - foot_w) // 2, divider_y + 22),
        footer,
        fill=MUTED,
        font=foot_font,
    )

    img.convert("RGB").save(out_path, "PNG", optimize=True)
    print(f"  -> {out_path.relative_to(ROOT)}")


def main(only=None):
    # PIL's default font is a small bitmap face that ignores the requested size,
    # so a fallback render silently overwrites every committed card with an
    # unreadable one. Refuse instead of degrading.
    if not FONT_BOLD or not FONT_REGULAR:
        raise SystemExit(
            "DejaVu fonts not found in any of:\n  "
            + "\n  ".join(FONT_DIRS)
            + "\nInstall them (macOS: `pip install matplotlib`, which bundles "
              "DejaVuSans.ttf / DejaVuSans-Bold.ttf) and re-run.\n"
              "Refusing to render with PIL's default bitmap font."
        )

    # Generic fallback — used for any site without a specific image, or when
    # SITE_NAME is unset. Same layout, "COMMUNITY SOLAR" as the headline.
    print("Generating cards:")
    if only is None:
        draw_card("Community Solar", PUBLIC / "og.png")

    for site_name, display in SITES:
        slug = slugify(site_name)
        if only and only not in slug:
            continue
        out = PUBLIC / f"og-{slug}.png"
        draw_card(display, out)
        print(f"     ({site_name!r} -> slug {slug!r})")

    print("Done.")


if __name__ == "__main__":
    # Optional slug filter: `generate-og-images.py homewise` regenerates just
    # that card and leaves the other committed PNGs byte-identical.
    main(only=(sys.argv[1].lower() if len(sys.argv) > 1 else None))
