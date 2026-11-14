"""產生 LINE 圖文選單圖片（2500×843，三格）。

用法：python tools/make_richmenu.py [輸出路徑]（需要 Pillow 與 Windows 的微軟正黑體）
預設輸出 assets/richmenu.png。改文字或顏色後重新執行即可。
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 2500, 843
S = 2                                   # 先畫兩倍大再縮小，邊緣比較平滑
GREEN = (6, 199, 85)
DARK = (31, 35, 40)
GRAY = (107, 114, 128)
LINE = (229, 231, 235)
WHITE = (255, 255, 255)
LIGHT = (247, 248, 249)

FONT_DIR = Path('C:/Windows/Fonts')
BOLD = str(FONT_DIR / 'msjhbd.ttc')
REG = str(FONT_DIR / 'msjh.ttc')

# (標題, 副標, 圖示, 背景, 主色, 副標色)
CELLS = [
    ('我想提前下班', '送出申請', 'clock', GREEN, WHITE, (220, 252, 231)),
    ('申請加班', '事前申請・事後補登', 'overtime', WHITE, DARK, GRAY),
    ('我的申請', '查進度・取消', 'list', LIGHT, DARK, GRAY),
]


def s(v):
    return int(v * S)


def icon_clock(d, cx, cy, r, color, bg):
    w = s(16)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=w)
    d.line([cx, cy, cx, cy - r * 0.58], fill=color, width=w)        # 分針
    d.line([cx, cy, cx + r * 0.45, cy + r * 0.22], fill=color, width=w)  # 時針
    d.ellipse([cx - w, cy - w, cx + w, cy + w], fill=color)
    # 右上角的「提早」箭頭
    ax, ay = cx + r * 0.95, cy - r * 0.95
    d.ellipse([ax - s(46), ay - s(46), ax + s(46), ay + s(46)], fill=color)
    d.line([ax - s(20), ay + s(20), ax + s(18), ay - s(18)], fill=bg, width=s(12))
    d.line([ax - s(8), ay - s(20), ax + s(20), ay - s(20)], fill=bg, width=s(12))
    d.line([ax + s(20), ay - s(20), ax + s(20), ay + s(8)], fill=bg, width=s(12))


def icon_list(d, cx, cy, r, color, bg):
    w = s(16)
    x0, y0, x1, y1 = cx - r * 0.78, cy - r, cx + r * 0.78, cy + r
    d.rounded_rectangle([x0, y0, x1, y1], radius=s(28), outline=color, width=w)
    d.rounded_rectangle([cx - r * 0.36, y0 - s(22), cx + r * 0.36, y0 + s(30)], radius=s(14), fill=color)
    for i, yy in enumerate((cy - r * 0.3, cy + r * 0.1, cy + r * 0.5)):
        # 打勾
        bx = x0 + r * 0.32
        d.line([bx - s(16), yy, bx - s(4), yy + s(14)], fill=color, width=s(11))
        d.line([bx - s(4), yy + s(14), bx + s(20), yy - s(14)], fill=color, width=s(11))
        d.line([bx + s(46), yy, x1 - r * 0.25, yy], fill=color, width=s(12))


def icon_person(d, cx, cy, r, color, bg):
    hr = r * 0.42
    d.ellipse([cx - hr, cy - r * 0.95, cx + hr, cy - r * 0.95 + 2 * hr], fill=color)
    d.chord([cx - r * 0.85, cy + r * 0.05, cx + r * 0.85, cy + r * 1.75], 180, 360, fill=color)
    # 右下角的打勾徽章
    bx, by, br = cx + r * 0.72, cy + r * 0.62, s(50)
    d.ellipse([bx - br - s(10), by - br - s(10), bx + br + s(10), by + br + s(10)], fill=bg)
    d.ellipse([bx - br, by - br, bx + br, by + br], fill=GREEN)
    d.line([bx - s(22), by, bx - s(6), by + s(18)], fill=WHITE, width=s(12))
    d.line([bx - s(6), by + s(18), bx + s(24), by - s(16)], fill=WHITE, width=s(12))


def icon_overtime(d, cx, cy, r, color, bg):
    w = s(16)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=w)
    d.line([cx, cy, cx, cy - r * 0.58], fill=color, width=w)        # 分針
    d.line([cx, cy, cx - r * 0.45, cy + r * 0.22], fill=color, width=w)  # 時針
    d.ellipse([cx - w, cy - w, cx + w, cy + w], fill=color)
    # 右上角的「＋」徽章
    ax, ay, ar = cx + r * 0.95, cy - r * 0.95, s(46)
    d.ellipse([ax - ar - s(10), ay - ar - s(10), ax + ar + s(10), ay + ar + s(10)], fill=bg)
    d.ellipse([ax - ar, ay - ar, ax + ar, ay + ar], fill=color)
    d.line([ax - s(22), ay, ax + s(22), ay], fill=bg, width=s(12))
    d.line([ax, ay - s(22), ax, ay + s(22)], fill=bg, width=s(12))


ICONS = {'clock': icon_clock, 'overtime': icon_overtime, 'list': icon_list, 'person': icon_person}


def centered(d, cx, y, text, font, fill):
    l, t, r, b = d.textbbox((0, 0), text, font=font)
    d.text((cx - (r - l) / 2 - l, y - t), text, font=font, fill=fill)


def main(out):
    img = Image.new('RGB', (s(W), s(H)), WHITE)
    d = ImageDraw.Draw(img)
    title_f = ImageFont.truetype(BOLD, s(118))
    sub_f = ImageFont.truetype(REG, s(60))
    bounds = [0, 833, 1667, 2500]
    for i, (title, sub, icon, bg, fg, subc) in enumerate(CELLS):
        x0, x1 = s(bounds[i]), s(bounds[i + 1])
        d.rectangle([x0, 0, x1, s(H)], fill=bg)
        cx = (x0 + x1) / 2
        ICONS[icon](d, cx, s(270), s(130), GREEN if bg != GREEN else WHITE, bg)
        centered(d, cx, s(500), title, title_f, fg)
        centered(d, cx, s(660), sub, sub_f, subc)
    # 白色格之間的分隔線
    d.line([s(1667), s(90), s(1667), s(H - 90)], fill=LINE, width=s(4))
    img = img.resize((W, H), Image.LANCZOS)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, optimize=True)
    print(f'{out}  {out.stat().st_size // 1024} KB')


if __name__ == '__main__':
    default = Path(__file__).resolve().parents[1] / 'assets' / 'richmenu.png'
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else default)
