"""用加班費專案的 loaders.parse_code 解析排班表，輸出給 JS 比對。

用法（用 OvertimeSalary 的虛擬環境執行）：
  ..\\OvertimeSalary\\.venv\\Scripts\\python.exe test\\parity\\dump_python.py ..\\OvertimeSalary

輸出 test/fixtures/schedule_dump.json（含人名，已列入 .gitignore，不要提交）。
"""
import json
import sys
from datetime import date, datetime
from pathlib import Path

ot_dir = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(ot_dir))
import openpyxl  # noqa: E402
import config  # noqa: E402
import loaders  # noqa: E402

out_path = Path(__file__).resolve().parents[1] / 'fixtures' / 'schedule_dump.json'
wb = openpyxl.load_workbook(loaders.config_path(config.SCHEDULE_FILE), data_only=True)


def cell(v):
    if isinstance(v, (datetime, date)):
        return {'$date': [v.year, v.month, v.day]}
    return v


def mins(m):
    return None if m is None else m


sheets = []
for sn in wb.sheetnames:
    if not (len(sn) == 5 and sn.isdigit() and 1 <= int(sn[3:]) <= 12):
        continue
    y, m = int(sn[:3]) + 1911, int(sn[3:])
    ws = wb[sn]
    grid = [[cell(c) for c in row] for row in ws.iter_rows(values_only=True)]
    # Python 對每一格的解析結果（以 JS 的人員列判斷方式無關：逐格用 parse_code）
    parsed = {}
    for c in range(2, 34):
        hdr = ws.cell(4, c).value
        if not hasattr(hdr, 'day'):
            break
        d = date(y, m, hdr.day)
        for r in range(6, ws.max_row + 1):
            p = loaders.parse_code(ws.cell(r, c).value, d)
            parsed[f'{r}:{c}'] = {
                'code': p.code, 'opener': p.opener, 'start': p.start, 'end': p.end,
                'base_start': p.base_start, 'note': p.note, 'unknown': p.unknown,
                'date': d.isoformat(), 'name': loaders.norm_name(ws.cell(r, 1).value),
            }
    py_rows = [r for r in config.SCHEDULE_ROWS if loaders.norm_name(ws.cell(r, 1).value)]
    sheets.append({'sheet': sn, 'year': y, 'month': m, 'grid': grid, 'parsed': parsed, 'py_rows': py_rows})

out_path.parent.mkdir(exist_ok=True)
out_path.write_text(json.dumps(sheets, ensure_ascii=False), encoding='utf-8')
print(f'{len(sheets)} 個月 → {out_path}')
