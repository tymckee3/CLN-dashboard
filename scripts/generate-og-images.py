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
GRID     = (255, 210, 120, 18)

# Fonts — DejaVu is present on most Linux distros (used by Pillow's default
# install path). Fall back to PIL default if missing.
FONT_DIRS = [
    "/usr/share/fonts/truetype/dejavu",
    "/Library/Fonts",
    "/System/Library/Fonts",
]

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
    """Matte-black panel with gold grid lines + radial glow behind the logo."""
    draw = ImageDraw.Draw(img, "RGBA")

    # Soft gold radial glow centered roughly where the logo + headline sit.
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    cx, cy = W // 2, H // 2 - 30
    for r in range(420, 40, -40):
        alpha = max(0, min(255, int(28 * (1 - r / 420))))
        gdraw.ellipse(
            [cx - r, cy - r, cx + r, cy + r],
            fill=(255, 190, 80, alpha),
        )
    glow = glow.filter(ImageFilter.GaussianBlur(40))
    img.alpha_composite(glow)

    # Grid — evenly spaced vertical + horizontal lines.
    cols, rows = 12, 7
    for i in range(1, cols):
        x = int(W * i / cols)
        draw.line([(x, 0), (x, H)], fill=GRID, width=1)
    for i in range(1, rows):
        y = int(H * i / rows)
        draw.line([(0, y), (W, y)], fill=GRID, width=1)


def paste_logo(img: Image.Image) -> int:
    """Paste the affordable solar logo centered horizontally; return y-bottom."""
    if not LOGO.exists():
        return 220
    logo = Image.open(LOGO).convert("RGBA")
    # Target width ~620px; preserve aspect ratio.
    target_w = 620
    ratio = target_w / logo.width
    target_h = int(logo.height * ratio)
    logo = logo.resize((target_w, target_h), Image.LANCZOS)
    x = (W - target_w) // 2
    y = 70
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
    logo_bottom = paste_logo(img)

    draw = ImageDraw.Draw(img)

    # Big gold headline — auto-size to fit so "GLOBAL GIVE A BOOK" and "WESST"
    # both look balanced.
    headline = display_name.upper()
    head_font, head_w, _ = fit_text(headline, FONT_BOLD, max_width=980, max_size=82, min_size=44)
    head_y = logo_bottom + 28
    draw.text(((W - head_w) // 2, head_y), headline, fill=GOLD, font=head_font)
    head_h = head_font.getbbox(headline)[3] - head_font.getbbox(headline)[1]

    # Subtitle — "Community Solar · Real-Time Dashboard"
    sub_font = load_font(FONT_REGULAR, 34)
    subtitle = "Community Solar  ·  Real-Time Dashboard"
    sub_w = sub_font.getbbox(subtitle)[2] - sub_font.getbbox(subtitle)[0]
    sub_y = head_y + head_h + 18
    draw.text(((W - sub_w) // 2, sub_y), subtitle, fill=WHITE, font=sub_font)

    # Divider
    divider_y = sub_y + 80
    draw.line(
        [(W // 2 - 90, divider_y), (W // 2 + 90, divider_y)],
        fill=GOLD + (140,) if False else GOLD,
        width=2,
    )

    # Footer
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


def main():
    if not FONT_BOLD:
        print("WARN: DejaVuSans-Bold not found; falling back to PIL default font")

    # Generic fallback — used for any site without a specific image, or when
    # SITE_NAME is unset. Same layout, "COMMUNITY SOLAR" as the headline.
    print("Generating cards:")
    draw_card("Community Solar", PUBLIC / "og.png")

    for site_name, display in SITES:
        slug = slugify(site_name)
        out = PUBLIC / f"og-{slug}.png"
        draw_card(display, out)
        print(f"     ({site_name!r} -> slug {slug!r})")

    print("Done.")


if __name__ == "__main__":
    main()
