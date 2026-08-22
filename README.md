# GTA Server List

Visor de listas de servidores para GTA multijugador de PC. Ventana única,
tema oscuro, cero dependencias externas en tiempo de ejecución (usa
`tkinter` y `urllib` de la librería estándar de Python).

## Para el jugador: el instalador

`dist_instalador\GTA-Server-List-Setup.exe` es el archivo que se cuelga en
`/descargas`. Es autocontenido (el `.exe` de dentro lleva Python empotrado
vía PyInstaller, el jugador no necesita instalar nada más), pesa ~11 MB,
instala sin pedir admin (`PrivilegesRequired=lowest`) y deja acceso directo
en el Escritorio y desinstalador. Wizard en español.

## Para tocar el código

```bash
python app.py
```

## Cómo reconstruir el instalador tras tocar `app.py`

```bash
python make_icon.py                       # solo si cambia el icono
python -m PyInstaller --noconfirm --clean --onefile --windowed --name "GTA Server List" --icon icon.ico app.py
"C:\Program Files\Inno Setup 7\ISCC.exe" instalador.iss
```

Deja el `.exe` final en `dist_instalador\GTA-Server-List-Setup.exe`. Sube el
número de versión en `instalador.iss` (`#define MyAppVersion`) antes de cada
build publicado — Inno Setup no lo hace por ti.

## Pestañas con lista en vivo

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

## Pestañas manuales

**VC:MP, GTA III MP y GTA IV MP no tienen un master server público** al que
pedirle "dame la lista completa". Para esos tres la pestaña es una libreta
de direcciones: añades `ip:puerto` a mano con **Añadir servidor** y
**Comprobar todos** hace un ping UDP — dice si el puerto responde, no trae
nombre ni jugadores porque no hay de dónde sacarlo sin hablar el protocolo
propio de cada juego. Las direcciones se guardan en
`servidores_manuales.json`, junto al `.exe`.

## Ampliarlo

Cada fuente en vivo es una función `fetch_xxx()` en `app.py` que devuelve una
lista de tuplas `(nombre, jugadores, modo, ip:puerto)`. Añadir un juego nuevo
con API pública es darle de alta ahí una función y una entrada en el
diccionario `LIVE_GAMES`.
