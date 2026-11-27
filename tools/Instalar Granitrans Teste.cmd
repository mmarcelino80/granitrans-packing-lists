@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

if not defined LOCALAPPDATA goto no_local_directory
set "PREVIEW_ROOT=%LOCALAPPDATA%\GranitransV02Teste"
set "PREVIEW_APP=%PREVIEW_ROOT%\app-logistica"
set "PREVIEW_VENV=%PREVIEW_ROOT%\venv"
set "PREVIEW_PYTHON=%PREVIEW_VENV%\Scripts\python.exe"
set "PREVIEW_REPO=https://github.com/mmarcelino80/granitrans-packing-lists.git"
set "PREVIEW_BRANCH=feat/packing-list-v02-openai"
set "PREVIEW_COMMIT=2c1ac30cd0ec0b9db80bf3f24518a2afbd13064b"

if not exist "%~dp0private_preview.py" goto missing_files
if not exist "%~dp0private-preview-requirements.txt" goto missing_files
git.exe --version >nul 2>&1
if errorlevel 1 goto no_git
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" goto find_python
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" goto find_python
if exist "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe" goto find_python
goto no_edge

:find_python
py.exe -3 -c "import struct, sys; raise SystemExit(sys.version_info < (3, 10) or struct.calcsize('P') != 8)" >nul 2>&1
if not errorlevel 1 (
  set "PREVIEW_BOOTSTRAP=py.exe -3"
  goto prepare_checkout
)
python.exe -c "import struct, sys; raise SystemExit(sys.version_info < (3, 10) or struct.calcsize('P') != 8)" >nul 2>&1
if errorlevel 1 goto no_python
set "PREVIEW_BOOTSTRAP=python.exe"

:prepare_checkout
if not exist "%PREVIEW_ROOT%\." mkdir "%PREVIEW_ROOT%"
if not exist "%PREVIEW_ROOT%\." goto install_failed
set "GIT_DIR="
set "GIT_WORK_TREE="
set "GIT_INDEX_FILE="
set "GIT_COMMON_DIR="

if exist "%PREVIEW_APP%" goto existing_checkout
set "PREVIEW_STAGE=%PREVIEW_ROOT%\instalacao-%RANDOM%-%RANDOM%"
mkdir "%PREVIEW_STAGE%" 2>nul
if errorlevel 1 goto install_failed

echo A obter a versão aprovada do repositório GitHub...
git.exe clone --no-checkout --no-tags --single-branch --branch "%PREVIEW_BRANCH%" "%PREVIEW_REPO%" "%PREVIEW_STAGE%"
if errorlevel 1 goto clone_failed
git.exe -C "%PREVIEW_STAGE%" checkout --detach "%PREVIEW_COMMIT%"
if errorlevel 1 goto checkout_failed
set "PREVIEW_CHECKOUT=%PREVIEW_STAGE%"
call :verify_checkout
if errorlevel 1 goto verification_failed
ren "%PREVIEW_STAGE%" app-logistica
if errorlevel 1 goto rename_failed
goto prepare_environment

:existing_checkout
set "PREVIEW_CHECKOUT=%PREVIEW_APP%"
call :verify_checkout
if errorlevel 1 goto different_checkout

:prepare_environment
if exist "%PREVIEW_PYTHON%" goto install_packages
echo A preparar o ambiente Python local...
%PREVIEW_BOOTSTRAP% -m venv "%PREVIEW_VENV%"
if errorlevel 1 goto install_failed

:install_packages
echo A instalar as dependências do teste privado...
"%PREVIEW_PYTHON%" -m pip --require-virtualenv --disable-pip-version-check install --no-input --only-binary=:all: -r "%~dp0private-preview-requirements.txt"
if errorlevel 1 goto install_failed
"%PREVIEW_PYTHON%" -c "from playwright.sync_api import sync_playwright"
if errorlevel 1 goto install_failed
echo.
echo Instalação concluída. Abra "Abrir Granitrans Teste.cmd" para iniciar o teste privado.
pause
exit /b 0

:verify_checkout
powershell.exe -NoProfile -NonInteractive -Command "$p=$env:PREVIEW_CHECKOUT; $o=git.exe -C $p config --local --get remote.origin.url; if ($LASTEXITCODE -ne 0 -or $o -cne $env:PREVIEW_REPO) { Write-Host 'Falha ao validar o endereco do repositorio.'; exit 1 }; $h=git.exe -C $p rev-parse --verify HEAD; if ($LASTEXITCODE -ne 0 -or $h -cne $env:PREVIEW_COMMIT) { Write-Host 'Falha ao validar o commit.'; exit 1 }; git.exe -C $p symbolic-ref --quiet HEAD; if ($LASTEXITCODE -ne 1) { Write-Host 'Falha ao validar o checkout destacado.'; exit 1 }; $s=git.exe -C $p status --porcelain=v1 --untracked-files=all; if ($LASTEXITCODE -ne 0 -or $s) { Write-Host 'Falha ao validar a pasta limpa.'; exit 1 }; exit 0"
exit /b %ERRORLEVEL%

:clone_failed
set "PREVIEW_ERROR=O Git não conseguiu descarregar o repositório."
goto failed_new_checkout

:checkout_failed
set "PREVIEW_ERROR=O Git não conseguiu selecionar o commit aprovado."
goto failed_new_checkout

:verification_failed
set "PREVIEW_ERROR=A cópia descarregada falhou a validação indicada acima."
goto failed_new_checkout

:rename_failed
set "PREVIEW_ERROR=O Windows não conseguiu mover a cópia validada para a pasta app-logistica."

:failed_new_checkout
rd /s /q "%PREVIEW_STAGE%" 2>nul
goto failure

:different_checkout
set "PREVIEW_ERROR=A pasta app-logistica já existe e contém uma cópia diferente ou alterada. A instalação preservou essa pasta."
goto failure

:no_local_directory
set "PREVIEW_ERROR=O Windows não disponibilizou a pasta de aplicações locais deste utilizador."
goto failure

:missing_files
set "PREVIEW_ERROR=Mantenha os ficheiros do teste privado juntos na mesma pasta e volte a executar a instalação."
goto failure

:no_git
set "PREVIEW_ERROR=Instale o Git para Windows e volte a executar a instalação."
goto failure

:no_edge
set "PREVIEW_ERROR=Instale o Microsoft Edge na localização padrão do Windows e volte a executar a instalação."
goto failure

:no_python
set "PREVIEW_ERROR=Instale o Python 64 bits, versão 3.10 ou mais recente, e volte a executar a instalação."
goto failure

:install_failed
set "PREVIEW_ERROR=A instalação não foi concluída. Consulte o erro acima e volte a executar este ficheiro."

:failure
echo.
echo %PREVIEW_ERROR%
pause
exit /b 1
