# GTA Server List

🇬🇧 [English](#english) · 🇪🇸 [Español](#español)

---

## English

Server list viewer for multiplayer GTA on PC. Single window, dark theme,
zero external runtime dependencies (uses `tkinter` and `urllib` from
Python's standard library).

### For players: the installer

`dist_instalador\GTA-Server-List-Setup.exe` is self-contained: the `.exe`
has Python bundled inside it (via PyInstaller), so players don't need to
install anything else. It's ~11 MB, doesn't ask for administrator
permissions during install, and leaves a desktop shortcut plus its own
uninstaller. The install wizard is in Spanish.

### To hack on the code

```bash
python app.py
```

### Rebuilding the installer after touching `app.py`

```bash
python make_icon.py                       # only if the icon changed
python -m PyInstaller --noconfirm --clean --onefile --windowed --name "GTA Server List" --icon icon.ico app.py
"C:\Program Files\Inno Setup 7\ISCC.exe" instalador.iss
```

The final `.exe` lands in `dist_instalador\GTA-Server-List-Setup.exe`. Bump
the version in `instalador.iss` (`#define MyAppVersion`) before every
published build — Inno Setup won't do it for you.

### Tabs with a live list

Public master server, refreshes itself on open (**Actualizar** button to
force it):

| Tab | Source |
|---|---|
| SA-MP / open.mp | `api.open.mp/servers` — official open.mp API, JSON |
| RAGE:MP | `cdn.rage.mp/master/` — official master list, JSON |
| MTA:SA | `master.multitheftauto.com/ase/mta/` — official list, but in an undocumented custom binary format. `fetch_mta()` in `app.py` parses it byte by byte; it's the same format already used by the SAX client in `SAX-V3\src\mtalista.js`, with comments on how each field was reverse-engineered |

Double-click a row to copy its IP:port to the clipboard.

FiveM was tried and dropped: its endpoint (`servers-frontend.fivem.net`)
isn't an officially supported CFX API and consistently returned 404.

### Manual tabs

**VC:MP, GTA III MP and GTA IV MP have no public master server** you can
ask for "give me the full list". For those three the tab is an address
book: you add `ip:port` by hand with **Añadir servidor**, and **Comprobar
todos** does a UDP ping — it tells you whether the port responds, not the
name or player count, because there's nowhere to pull that from without
speaking each game's own protocol. Addresses are saved in
`servidores_manuales.json`, next to the `.exe`.

### Extending it

Each live source is a `fetch_xxx()` function in `app.py` that returns a
list of `(name, players, mode, ip:port)` tuples. Adding a new game with a
public API means adding a function there and an entry in the `LIVE_GAMES`
dictionary.

---

## Español

Visor de listas de servidores para GTA multijugador de PC. Ventana única,
tema oscuro, cero dependencias externas en tiempo de ejecución (usa
`tkinter` y `urllib` de la librería estándar de Python).

### Para el jugador: el instalador

`dist_instalador\GTA-Server-List-Setup.exe` es autocontenido: el `.exe` de
dentro lleva Python empotrado (vía PyInstaller), así que el jugador no
necesita instalar nada más. Pesa ~11 MB, no pide permisos de administrador
al instalar, y deja acceso directo en el Escritorio junto con su propio
desinstalador. El asistente de instalación está en español.

### Para tocar el código

```bash
python app.py
```

### Cómo reconstruir el instalador tras tocar `app.py`

```bash
python make_icon.py                       # solo si cambia el icono
python -m PyInstaller --noconfirm --clean --onefile --windowed --name "GTA Server List" --icon icon.ico app.py
"C:\Program Files\Inno Setup 7\ISCC.exe" instalador.iss
```

Deja el `.exe` final en `dist_instalador\GTA-Server-List-Setup.exe`. Sube el
número de versión en `instalador.iss` (`#define MyAppVersion`) antes de cada
build publicado — Inno Setup no lo hace por ti.

### Pestañas con lista en vivo

Master server público, se refrescan solas al abrir (botón **Actualizar**
para forzar):

| Pestaña | Fuente |
|---|---|
| SA-MP / open.mp | `api.open.mp/servers` — API oficial de open.mp, JSON |
| RAGE:MP | `cdn.rage.mp/master/` — master list oficial, JSON |
| MTA:SA | `master.multitheftauto.com/ase/mta/` — lista oficial, pero en un binario propio sin documentar. `fetch_mta()` en `app.py` lo interpreta byte a byte; es el mismo formato que ya usa el cliente SAX en `SAX-V3\src\mtalista.js`, con los comentarios de cómo se descubrió cada campo |

Doble clic en una fila copia la IP:puerto al portapapeles.

FiveM se probó y se quitó: su endpoint (`servers-frontend.fivem.net`) no es
una API con soporte oficial de CFX y devolvía 404 de forma consistente.

### Pestañas manuales

**VC:MP, GTA III MP y GTA IV MP no tienen un master server público** al que
pedirle "dame la lista completa". Para esos tres la pestaña es una libreta
de direcciones: añades `ip:puerto` a mano con **Añadir servidor** y
**Comprobar todos** hace un ping UDP — dice si el puerto responde, no trae
nombre ni jugadores porque no hay de dónde sacarlo sin hablar el protocolo
propio de cada juego. Las direcciones se guardan en
`servidores_manuales.json`, junto al `.exe`.

### Ampliarlo

Cada fuente en vivo es una función `fetch_xxx()` en `app.py` que devuelve una
lista de tuplas `(nombre, jugadores, modo, ip:puerto)`. Añadir un juego nuevo
con API pública es darle de alta ahí una función y una entrada en el
diccionario `LIVE_GAMES`.
