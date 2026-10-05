@echo off
rem Lanzador de TiempoPesca para Windows: doble clic para abrir la web.
chcp 65001 >nul
title TiempoPesca
cd /d "%~dp0"

rem Busca Python 3: primero el lanzador "py", luego "python"
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY (
    python --version >nul 2>&1 && set "PY=python"
)

if not defined PY (
    echo.
    echo  No se ha encontrado Python en este equipo.
    echo.
    echo  1. Descargalo de https://www.python.org/downloads/
    echo  2. Al instalarlo, marca la casilla "Add python.exe to PATH".
    echo  3. Vuelve a hacer doble clic en este archivo.
    echo.
    start "" "https://www.python.org/downloads/"
    pause
    exit /b 1
)

echo.
echo  Arrancando TiempoPesca... se abrira el navegador.
echo  Para apagarlo, cierra esta ventana.
echo.
%PY% "programa\app\server.py" --abrir

rem Si el servidor termina con error, deja la ventana abierta para leerlo
if errorlevel 1 pause
