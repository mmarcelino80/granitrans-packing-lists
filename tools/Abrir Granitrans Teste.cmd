@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

if not defined LOCALAPPDATA goto missing_installation
set "PREVIEW_ROOT=%LOCALAPPDATA%\GranitransV02Teste"
set "PREVIEW_PYTHON=%PREVIEW_ROOT%\venv\Scripts\python.exe"

if not exist "%~dp0private_preview.py" goto missing_installation
if not exist "%PREVIEW_PYTHON%" goto missing_installation
if not exist "%PREVIEW_ROOT%\app-logistica\index.html" goto missing_installation

"%PREVIEW_PYTHON%" -B "%~dp0private_preview.py" --source "%PREVIEW_ROOT%\app-logistica"
set "PREVIEW_EXIT=%ERRORLEVEL%"
if "%PREVIEW_EXIT%"=="0" exit /b 0
echo.
echo O teste privado terminou com um erro. Consulte a mensagem acima.
pause
exit /b %PREVIEW_EXIT%

:missing_installation
echo Execute primeiro "Instalar Granitrans Teste.cmd" e mantenha os ficheiros juntos na mesma pasta.
pause
exit /b 1
