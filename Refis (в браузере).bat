@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo Сначала один раз запустите Refis.bat
    pause
    exit /b 1
)
echo Refis работает. Не закрывайте это окно, пока пользуетесь приложением.
".venv\Scripts\python.exe" -m refis --browser
