@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Первый запуск: создаём окружение Python и ставим зависимости
if not exist ".venv\Scripts\python.exe" (
    echo Первый запуск: готовлю окружение, это займёт пару минут...
    where py >nul 2>nul && (py -3 -m venv .venv) || (python -m venv .venv)
    if not exist ".venv\Scripts\python.exe" (
        echo.
        echo Не найден Python. Установите Python 3.12 или 3.13 с https://www.python.org/downloads/
        echo При установке отметьте галочку "Add python.exe to PATH".
        pause
        exit /b 1
    )
    ".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo Не удалось установить зависимости. Проверьте интернет и запустите ещё раз.
        rmdir /s /q .venv
        pause
        exit /b 1
    )
)

rem Обновились зависимости — доустанавливаем
fc /b requirements.txt ".venv\requirements.txt" >nul 2>nul || (
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    copy /y requirements.txt ".venv\requirements.txt" >nul
)

start "" ".venv\Scripts\pythonw.exe" -m refis %*
