#!/usr/bin/env bash
# Lanzador de TiempoPesca para Linux: ejecútalo (doble clic → "Ejecutar") para abrir la web.

cd "$(dirname "$(readlink -f "$0")")" || exit 1

# Si se ha abierto con doble clic (sin terminal), se reabre en una terminal
# para poder ver los mensajes y apagarlo cerrando la ventana.
if [ ! -t 1 ] && [ -z "$TIEMPOPESCA_EN_TERMINAL" ]; then
    export TIEMPOPESCA_EN_TERMINAL=1
    for term in x-terminal-emulator gnome-terminal konsole xfce4-terminal mate-terminal tilix kitty alacritty xterm; do
        if command -v "$term" >/dev/null 2>&1; then
            case "$term" in
                gnome-terminal) exec "$term" -- "$0" ;;
                *)              exec "$term" -e "$0" ;;
            esac
        fi
    done
    # Sin terminal disponible: se sigue en segundo plano
fi

aviso() {
    echo "$1"
    command -v notify-send >/dev/null 2>&1 && notify-send "TiempoPesca" "$1"
    command -v zenity >/dev/null 2>&1 && [ ! -t 1 ] && zenity --error --text="$1"
}

if ! command -v python3 >/dev/null 2>&1; then
    aviso "No se ha encontrado Python 3. Instálalo con el gestor de paquetes de tu distribución (por ejemplo: sudo apt install python3)."
    [ -t 0 ] && read -rp "Pulsa Intro para cerrar..."
    exit 1
fi

echo
echo "  Arrancando TiempoPesca... se abrirá el navegador."
echo "  Para apagarlo, cierra esta ventana o pulsa Ctrl+C."
echo
python3 programa/app/server.py --abrir
codigo=$?

if [ $codigo -ne 0 ] && [ $codigo -ne 130 ] && [ -t 0 ]; then
    read -rp "Ha habido un error. Pulsa Intro para cerrar..."
fi
exit $codigo
