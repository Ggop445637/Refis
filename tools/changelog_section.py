"""Печатает раздел CHANGELOG.md для указанной версии — он становится описанием релиза."""
import re
import sys
from pathlib import Path

version = sys.argv[1].lstrip("v")
text = (Path(__file__).resolve().parent.parent / "CHANGELOG.md").read_text(encoding="utf-8")
m = re.search(rf"^## \[{re.escape(version)}\][^\n]*\n(.*?)(?=^## \[|\Z)", text, re.S | re.M)
body = m.group(1).strip() if m else f"Refis {version}"
print(body + "\n\n---\n**Установка / Install:** скачайте `Refis-Setup-…exe` ниже. Windows может показать предупреждение "
      "SmartScreen — нажмите «Подробнее» → «Выполнить в любом случае» (программа не подписана платным сертификатом).")
