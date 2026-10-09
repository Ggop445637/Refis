"""Собирает все строки для перевода: tr("…") и plural(…) в JS, текст и подсказки в index.html.

python tools/i18n_keys.py            — список ключей
python tools/i18n_keys.py --missing  — ключи без английского перевода (код возврата 1, если есть)
"""
import json
import re
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JS = ROOT / "refis" / "static" / "js"
CYR = re.compile(r"[А-Яа-яЁё]")
TR = re.compile(r'\btr\(("(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\')\)')
PLURAL = re.compile(r'plural\([^,]+,\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\)')


def js_keys() -> set[str]:
    keys = set()
    for f in JS.glob("*.js"):
        src = f.read_text(encoding="utf-8")
        for m in TR.finditer(src):
            lit = m.group(1)
            if lit.startswith("'"):
                lit = '"' + lit[1:-1].replace('"', '\\"') + '"'
            keys.add(json.loads(lit))
        for m in PLURAL.finditer(src):
            keys.add("|".join(m.groups()))
    return keys


class _Html(HTMLParser):
    def __init__(self):
        super().__init__()
        self.keys, self.skip = set(), 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        for k, v in attrs:
            if k in ("placeholder", "title") and v and CYR.search(v):
                self.keys.add(v)

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip and CYR.search(data):
            self.keys.add(data.strip())


def html_keys() -> set[str]:
    p = _Html()
    p.feed((ROOT / "refis" / "static" / "index.html").read_text(encoding="utf-8"))
    return p.keys


def all_keys() -> set[str]:
    return js_keys() | html_keys()


def en_dict() -> dict:
    out = subprocess.run(["node", "-e", "import('./refis/static/js/lang/en.js').then(m => process.stdout.write(JSON.stringify(m.default)))"],
                         cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


if __name__ == "__main__":
    keys = all_keys()
    if "--missing" in sys.argv:
        en = en_dict()
        missing = sorted(k for k in keys if k not in en)
        unused = sorted(k for k in en if k not in keys)
        for k in missing:
            print("НЕТ ПЕРЕВОДА:", k)
        for k in unused:
            print("лишний ключ:", k)
        sys.exit(1 if missing else 0)
    for k in sorted(keys):
        print(k)
