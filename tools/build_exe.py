"""Собирает Refis.exe через PyInstaller: dist/Refis/Refis.exe (+ папка _internal).

Запуск:  python tools/build_exe.py
"""
import os
import sys
from pathlib import Path

import PyInstaller.__main__

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from refis import __version__  # noqa: E402


def version_file() -> Path:
    """Сведения о программе, которые Windows показывает в свойствах .exe."""
    nums = [int(x) for x in __version__.split(".")[:3]] + [0]
    while len(nums) < 4:
        nums.append(0)
    t = tuple(nums[:4])
    text = f"""
VSVersionInfo(
  ffi=FixedFileInfo(filevers={t}, prodvers={t}, mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('041904B0', [
      StringStruct('CompanyName', 'Refis'),
      StringStruct('FileDescription', 'Refis — библиотека референсов'),
      StringStruct('FileVersion', '{__version__}'),
      StringStruct('InternalName', 'Refis'),
      StringStruct('OriginalFilename', 'Refis.exe'),
      StringStruct('ProductName', 'Refis'),
      StringStruct('ProductVersion', '{__version__}')])]),
    VarFileInfo([VarStruct('Translation', [0x0419, 1200])])
  ]
)
"""
    p = ROOT / "build" / "version_info.txt"
    p.parent.mkdir(exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


def main() -> None:
    sep = os.pathsep
    args = [
        str(ROOT / "refis_app.py"),
        "--name", "Refis",
        "--noconfirm",
        "--clean",
        "--windowed",
        "--icon", str(ROOT / "assets" / "refis.ico"),
        "--add-data", f"{ROOT / 'refis' / 'static'}{sep}refis/static",
        "--collect-all", "imageio_ffmpeg",
        "--collect-submodules", "uvicorn",
        "--collect-submodules", "send2trash",  # платформенный модуль выбирается при импорте
        "--distpath", str(ROOT / "dist"),
        "--workpath", str(ROOT / "build"),
        "--specpath", str(ROOT / "build"),
    ]
    if sys.platform == "win32":
        args += ["--version-file", str(version_file()), "--collect-all", "webview"]
    PyInstaller.__main__.run(args)


if __name__ == "__main__":
    main()
