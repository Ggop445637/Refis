"""Раздел CHANGELOG.md для указанной версии — он становится описанием релиза.

python tools/changelog_section.py 2.2.0 dist/notes.md
Пишет файл в UTF-8 напрямую: консоль Windows (cp1252) не умеет печатать кириллицу.
"""
import re
import sys
from pathlib import Path

version = sys.argv[1].lstrip("v")
out = Path(sys.argv[2]) if len(sys.argv) > 2 else None
text = (Path(__file__).resolve().parent.parent / "CHANGELOG.md").read_text(encoding="utf-8")
m = re.search(rf"^## \[{re.escape(version)}\][^\n]*\n(.*?)(?=^## \[|\Z)", text, re.S | re.M)
body = m.group(1).strip() if m else f"Refis {version}"
body += ("\n\n---\n**Установка / Install:** скачайте `Refis-Setup-…exe` ниже или портативный `Refis-portable-….zip`. "
         "Windows может показать предупреждение SmartScreen — нажмите «Подробнее» → «Выполнить в любом случае» "
         "(программа не подписана платным сертификатом).")
if out:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(body + "\n", encoding="utf-8")
else:
    sys.stdout.buffer.write((body + "\n").encode("utf-8"))
