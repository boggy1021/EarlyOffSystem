"""產生圖解小手冊的公開網頁與 PDF。

原稿：guide/guide.fragment.html（也是 Claude Artifact 發布的那一份，沒有 <html>/<head> 外殼）
輸出：
  liff/guide.html            → GitHub Pages：https://boggy1021.github.io/EarlyOffSystem/guide.html
  output/提前下班圖解小手冊.pdf → 用 Edge 無頭模式列印（output/ 不進 git）

用法：python tools/build_guide.py [--no-pdf]
"""
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'guide' / 'guide.fragment.html'
WEB = ROOT / 'liff' / 'guide.html'
PDF = ROOT / 'output' / '提前下班圖解小手冊.pdf'
EDGE = Path(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')

HEAD = """<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
"""

PRINT_CSS = """<style>
@page { size: A4; margin: 12mm; }
.step, .fact, .choice, .rule, .timeline, details, .end, .sec-head { break-inside: avoid; }
.sec-head { break-after: avoid; }
/* Chrome 不在 grid 版面裡處理 break-after，列印時改成一般區塊排版 */
.wrap, section, .steps, .faq { display: block; }
.wrap > * + * { margin-top: 34px; }
section > * + *, .steps > * + * { margin-top: 16px; }
.faq > * + * { margin-top: 6px; }
.hero .phone { animation: none !important; }
details > summary::before { content: "" !important; width: 0; }
.faq { gap: 6px; }
details { padding: 0 14px; }
summary { padding: 7px 0 2px; }
details p { padding: 0 0 7px 0; }
.end { display: none; }
.faq::after { content: "有問題或畫面出現錯誤，截圖傳給管理者就好。"; color: var(--green-deep); font-weight: 700; padding: 6px 4px 0; }
</style>
"""


def build_web(fragment):
    WEB.write_text(HEAD + '</head>\n<body>\n' + fragment + '\n</body>\n</html>\n', encoding='utf-8')
    print(f'網頁：{WEB}')


def embedded_display_font(fragment):
    """無頭列印不會等網路字型載入，所以把圓體（Huninn）只取用到的字，內嵌成 data URI。"""
    import base64
    import re
    import urllib.parse
    import urllib.request
    chars = ''.join(sorted(set(re.sub(r'<[^>]+>', '', fragment)) - set(' \n\t')))
    url = 'https://fonts.googleapis.com/css2?family=Huninn&text=' + urllib.parse.quote(chars)
    ua = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36'}
    css = urllib.request.urlopen(urllib.request.Request(url, headers=ua), timeout=30).read().decode()
    font_url = re.search(r'src: url\((.+?)\)', css).group(1)
    data = urllib.request.urlopen(urllib.request.Request(font_url, headers=ua), timeout=30).read()
    b64 = base64.b64encode(data).decode()
    return ("<style>@font-face{font-family:'Huninn';font-weight:400;"
            f"src:url(data:font/woff2;base64,{b64}) format('woff2');}}</style>\n")


def build_pdf(fragment):
    # PDF 版：常見問題全部展開、圓體內嵌、加上列印分頁設定
    printable = fragment.replace('<details>', '<details open>')
    printable = printable.replace('family=Huninn&amp;', 'family=').replace('family=Huninn&', 'family=')
    # 列印樣式放在原稿之後，才蓋得過原稿裡的同名規則
    html = HEAD + embedded_display_font(fragment) + '</head>\n<body>\n' + printable + PRINT_CSS + '\n</body>\n</html>\n'
    PDF.parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / 'guide-print.html'
        src.write_text(html, encoding='utf-8')
        subprocess.run([
            str(EDGE), '--headless=new', '--disable-gpu', '--no-pdf-header-footer',
            '--virtual-time-budget=15000',              # 等 Google Fonts 載入
            f'--print-to-pdf={PDF}', src.as_uri(),
        ], check=True, capture_output=True, timeout=120)
    print(f'PDF：{PDF}  {PDF.stat().st_size // 1024} KB')


if __name__ == '__main__':
    frag = SRC.read_text(encoding='utf-8')
    build_web(frag)
    if '--no-pdf' not in sys.argv:
        build_pdf(frag)
