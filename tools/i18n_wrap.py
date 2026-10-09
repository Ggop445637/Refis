"""Оборачивает русский текст в JS-файлах в tr("…") для перевода интерфейса.

Запуск: python tools/i18n_wrap.py refis/static/js/*.js   (идемпотентно — повторно не оборачивает)
Пропускает комментарии, однобуквенные строки (клавиши «р», «ф»…), аргументы plural() и уже обёрнутое.
"""
import re
import sys
from pathlib import Path

CYR = re.compile(r"[А-Яа-яЁё]")
# «кусок текста» внутри шаблона: от первой буквы до последней, без разметки и ${}
RUN = re.compile(r"[А-Яа-яЁё0-9A-Za-z][^<>{}`$\n\"=]*[А-Яа-яЁё0-9.!?…»)%]|[А-Яа-яЁё]")


def wrap_template_text(text: str) -> str:
    """Статический текст шаблона: русские куски → ${t("…")}."""
    out, last = [], 0
    for m in RUN.finditer(text):
        frag = m.group(0)
        if not CYR.search(frag):
            continue
        # обрезаем служебные хвосты вроде « · », «: » — они останутся в разметке
        lead = len(frag) - len(frag.lstrip(" ·:—–,"))
        frag2 = frag.strip(" ·:—–,")
        start = m.start() + lead
        end = start + len(frag2)
        out.append(text[last:start])
        out.append('${tr("' + frag2.replace('"', '\\"') + '")}')  # обратные черты в шаблоне уже экранированы
        last = end
    out.append(text[last:])
    return "".join(out)


def _regex_allowed(before: str) -> bool:
    """«/» начинает регулярное выражение, если перед ним оператор или открывающая скобка."""
    tail = before.rstrip()
    if not tail:
        return True
    if re.search(r"(\breturn|\btypeof|\bcase|\bin|\bof)$", tail):
        return True
    return tail[-1] in "(,=:[!&|?{};+-*%<>~^"


def transform(src: str) -> str:
    out = []
    i, n = 0, len(src)
    stack = []  # контексты: "tpl" (внутри `...`) или "code" (внутри ${...})
    depth = []  # глубина фигурных скобок для каждого ${

    def in_template():
        return stack and stack[-1] == "tpl"

    while i < n:
        c = src[i]
        if in_template():
            # статический текст шаблона до ` или ${
            j = i
            seg = []
            while j < n and src[j] != "`" and not (src[j] == "$" and j + 1 < n and src[j + 1] == "{"):
                if src[j] == "\\":
                    seg.append(src[j:j + 2])
                    j += 2
                    continue
                seg.append(src[j])
                j += 1
            text = "".join(seg)
            # не трогаем текст, который уже аргумент t`…`
            prev = "".join(out)[-3:]
            out.append(wrap_template_text(text) if CYR.search(text) and not prev.endswith("tr`") else text)
            i = j
            if i < n and src[i] == "`":
                out.append("`")
                stack.pop()
                i += 1
            elif i < n:
                out.append("${")
                stack.append("code")
                depth.append(0)
                i += 2
            continue
        # обычный код (верхний уровень или внутри ${…})
        if c == "/" and src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j < 0 else j
            out.append(src[i:j]); i = j; continue
        if c == "/" and src.startswith("/*", i):
            j = src.find("*/", i) + 2
            out.append(src[i:j]); i = j; continue
        if c == "/" and _regex_allowed("".join(out[-40:])):
            # литерал регулярного выражения: кавычки внутри — не строки
            j, in_class = i + 1, False
            while j < n:
                ch = src[j]
                if ch == "\\":
                    j += 2
                    continue
                if ch == "[":
                    in_class = True
                elif ch == "]":
                    in_class = False
                elif ch == "/" and not in_class:
                    break
                elif ch == "\n":
                    break
                j += 1
            j += 1
            while j < n and src[j].isalpha():
                j += 1
            out.append(src[i:j])
            i = j
            continue
        if c in "\"'":
            j = i + 1
            while j < n and src[j] != c:
                j += 2 if src[j] == "\\" else 1
            lit = src[i:j + 1]
            body = lit[1:-1]
            before = "".join(out[-3:])[-12:]
            already = re.search(r"\btr\($", before)
            in_plural = re.search(r"plural\([^()]*$", "".join(out)[-80:])
            if CYR.search(body) and len(body) > 1 and not already and not in_plural:
                out.append("tr(" + lit + ")")
            else:
                out.append(lit)
            i = j + 1
            continue
        if c == "`":
            out.append("`")
            stack.append("tpl")
            i += 1
            continue
        if stack and stack[-1] == "code":
            if c == "{":
                depth[-1] += 1
            elif c == "}":
                if depth[-1] == 0:
                    out.append("}")
                    stack.pop()
                    depth.pop()
                    i += 1
                    continue
                depth[-1] -= 1
        out.append(c)
        i += 1
    return "".join(out)


if __name__ == "__main__":
    for path in sys.argv[1:]:
        p = Path(path)
        src = p.read_text(encoding="utf-8")
        res = transform(src)
        if res != src:
            p.write_text(res, encoding="utf-8")
            print("обёрнуто:", p)
