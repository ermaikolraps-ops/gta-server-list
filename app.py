"""
GTA Server List — visor de listas de servidores para GTA multijugador de PC.

Cero dependencias externas: solo la librería estándar de Python (tkinter + urllib).
Cada juego tiene su propia pestaña. Las que tienen master server público (open.mp/SA-MP,
RAGE:MP, MTA:SA) se refrescan solas. Las que no tienen master list público (VC:MP,
GTA III MP, GTA IV MP) son de "servidores guardados a mano": tú añades ip:puerto y la app
solo comprueba si el puerto responde (no hay API oficial de la que sacar nombre/jugadores).
"""

import json
import re
import socket
import struct
import sys
import threading
import tkinter as tk
import urllib.error
import urllib.request
from pathlib import Path
from tkinter import font as tkfont
from tkinter import simpledialog, ttk

if getattr(sys, "frozen", False):
    APP_DIR = Path(sys.executable).resolve().parent
else:
    APP_DIR = Path(__file__).resolve().parent

MANUAL_FILE = APP_DIR / "servidores_manuales.json"
ICON_FILE = APP_DIR / "icon.ico"
USER_AGENT = "Mozilla/5.0 (GTA-ServerList-Viewer)"
TIMEOUT = 8

# ---------------------------------------------------------------------------
# Paleta — radar verde de noche, como el minimapa de San Andreas
# ---------------------------------------------------------------------------
BG = "#12151a"
PANEL = "#181c23"
PANEL_ALT = "#1f242d"
ROW_ODD = "#1b2028"
ROW_EVEN = "#161a21"
BORDER = "#2a313c"
FG = "#e7ebf0"
FG_DIM = "#8b95a3"
GREEN = "#6ee76e"
GREEN_DIM = "#3d8f4a"
AMBER = "#ffb340"
RED = "#ff6b6b"


def http_get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


# ---------------------------------------------------------------------------
# Fetchers: cada uno devuelve una lista de tuplas (nombre, jugadores, modo, ip:puerto)
# ---------------------------------------------------------------------------

def fetch_openmp():
    data = http_get_json("https://api.open.mp/servers")
    rows = []
    for s in data:
        nombre = s.get("hn", "?")
        jugadores = f'{s.get("pc", 0)}/{s.get("pm", 0)}'
        modo = s.get("gm", "")
        ip = s.get("ip", "")
        rows.append((nombre, jugadores, modo, ip))
    return rows


def fetch_ragemp():
    data = http_get_json("https://cdn.rage.mp/master/")
    rows = []
    for ip, s in data.items():
        nombre = s.get("name", "?")
        jugadores = f'{s.get("players", 0)}/{s.get("maxplayers", 0)}'
        modo = s.get("gamemode", "")
        rows.append((nombre, jugadores, modo, ip))
    return rows


MTA_LISTA_URL = "https://master.multitheftauto.com/ase/mta/"
_QUITAR_COLOR_MTA = re.compile(r"#[0-9A-Fa-f]{6}")


def fetch_mta():
    # Misma lista que usa el navegador de servidores de MTA. No es JSON: es
    # binario propio, sin documentar oficialmente. El formato exacto (sacado
    # byte a byte) está portado de src/mtalista.js del cliente SAX:
    #
    #   Cabecera, 16 bytes big-endian: version, sello, sello, nº servidores.
    #   Por cada servidor: u16 largo-de-entrada, u32 IP en orden INVERSO,
    #   u16 puerto, u16 jugadores, u16 tope, cadena-nombre (u8 largo + utf8),
    #   cadena-version (u8 largo + latin1), u8 tiene-contraseña.
    req = urllib.request.Request(MTA_LISTA_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        buf = resp.read()

    if len(buf) < 20:
        raise ValueError("Lista de MTA demasiado corta (formato cambiado)")

    rows = []
    vistos = set()
    o = 16
    while o + 2 <= len(buf):
        largo = struct.unpack_from(">H", buf, o)[0]
        if largo < 16 or o + largo > len(buf):
            break
        fin = o + largo
        p = o + 2

        ip = f"{buf[p+3]}.{buf[p+2]}.{buf[p+1]}.{buf[p]}"
        p += 4
        puerto = struct.unpack_from(">H", buf, p)[0]; p += 2
        jugadores = struct.unpack_from(">H", buf, p)[0]; p += 2
        maximo = struct.unpack_from(">H", buf, p)[0]; p += 2

        largo_nombre = buf[p]; p += 1
        if p + largo_nombre > fin:
            o = fin
            continue
        nombre = _QUITAR_COLOR_MTA.sub("", buf[p:p + largo_nombre].decode("utf-8", "replace")).strip()
        p += largo_nombre

        largo_version = buf[p]; p += 1
        if p + largo_version > fin:
            o = fin
            continue
        p += largo_version

        o = fin
        if not puerto or puerto > 65535:
            continue
        direccion = f"{ip}:{puerto}"
        if direccion in vistos:
            continue
        vistos.add(direccion)

        rows.append((nombre or direccion, f"{jugadores}/{maximo}", "", direccion))

    if not rows:
        raise ValueError("No se pudo leer ningún servidor (formato cambiado)")
    return rows


LIVE_GAMES = {
    "SA-MP / open.mp": fetch_openmp,
    "RAGE:MP": fetch_ragemp,
    "MTA:SA": fetch_mta,
}

# Juegos sin master server público conocido: solo lista manual + comprobación de puerto.
MANUAL_GAMES = ["VC:MP (Vice City)", "GTA III MP", "GTA IV MP"]


def load_manual():
    if MANUAL_FILE.exists():
        try:
            return json.loads(MANUAL_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {g: [] for g in MANUAL_GAMES}


def save_manual(data):
    MANUAL_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def check_port(ip, port, is_udp=False, timeout=2.0):
    try:
        if is_udp:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(timeout)
            s.sendto(b"\x00", (ip, port))
            s.close()
            return "desconocido (UDP)"
        else:
            s = socket.create_connection((ip, port), timeout=timeout)
            s.close()
            return "en linea"
    except Exception:
        return "sin respuesta"


# ---------------------------------------------------------------------------
# Estilo
# ---------------------------------------------------------------------------

def aplicar_estilo(root):
    style = ttk.Style(root)
    style.theme_use("clam")

    base_font = tkfont.nametofont("TkDefaultFont")
    base_font.configure(family="Segoe UI", size=10)
    root.option_add("*Font", base_font)

    root.configure(bg=BG)

    style.configure("TFrame", background=BG)
    style.configure("Panel.TFrame", background=PANEL)
    style.configure("TLabel", background=BG, foreground=FG)
    style.configure("Dim.TLabel", background=BG, foreground=FG_DIM)
    style.configure("Header.TLabel", background=BG, foreground=GREEN,
                     font=("Segoe UI Semibold", 15))
    style.configure("Sub.TLabel", background=BG, foreground=FG_DIM, font=("Segoe UI", 9))
    style.configure("Status.TLabel", background=BG, foreground=FG_DIM, font=("Segoe UI", 9))

    style.configure("TEntry", fieldbackground=PANEL_ALT, background=PANEL_ALT,
                     foreground=FG, bordercolor=BORDER, lightcolor=BORDER, darkcolor=BORDER,
                     insertcolor=FG, padding=6)
    style.map("TEntry", fieldbackground=[("focus", PANEL_ALT)])

    style.configure("TButton", background=PANEL_ALT, foreground=FG, bordercolor=BORDER,
                     focusthickness=0, padding=(12, 7))
    style.map("TButton",
              background=[("active", "#262c37"), ("pressed", "#12151a")],
              foreground=[("disabled", FG_DIM)])

    style.configure("Accent.TButton", background=GREEN_DIM, foreground="#0d130e",
                     bordercolor=GREEN_DIM, padding=(12, 7))
    style.map("Accent.TButton", background=[("active", GREEN), ("pressed", GREEN_DIM)])

    style.configure("TNotebook", background=BG, bordercolor=BG, tabmargins=(8, 8, 8, 0))
    style.configure("TNotebook.Tab", background=PANEL, foreground=FG_DIM,
                     padding=(16, 9), bordercolor=BORDER, font=("Segoe UI", 10))
    style.map("TNotebook.Tab",
              background=[("selected", PANEL_ALT)],
              foreground=[("selected", GREEN)],
              expand=[("selected", (1, 1, 1, 0))])

    style.configure("Treeview", background=ROW_EVEN, fieldbackground=ROW_EVEN,
                     foreground=FG, bordercolor=BORDER, borderwidth=0,
                     rowheight=26, font=("Segoe UI", 10))
    style.configure("Treeview.Heading", background=PANEL_ALT, foreground=GREEN,
                     bordercolor=BORDER, relief="flat", font=("Segoe UI Semibold", 9))
    style.map("Treeview.Heading", background=[("active", PANEL_ALT)])
    style.map("Treeview",
              background=[("selected", GREEN_DIM)],
              foreground=[("selected", "#0d130e")])

    style.configure("Vertical.TScrollbar", background=PANEL_ALT, troughcolor=BG,
                     bordercolor=BG, arrowcolor=FG_DIM)


# ---------------------------------------------------------------------------
# UI
# ---------------------------------------------------------------------------

class ServerTab(ttk.Frame):
    def __init__(self, master, fetch_fn):
        super().__init__(master, style="TFrame")
        self.fetch_fn = fetch_fn
        self._build()

    def _build(self):
        top = ttk.Frame(self)
        top.pack(fill="x", padx=14, pady=(14, 8))

        ttk.Label(top, text="Buscar").pack(side="left")
        self.filtro = tk.StringVar()
        self.filtro.trace_add("write", lambda *_: self._aplicar_filtro())
        entry = ttk.Entry(top, textvariable=self.filtro, width=32)
        entry.pack(side="left", padx=(8, 0))

        ttk.Button(top, text="Actualizar", style="Accent.TButton",
                   command=self.refrescar).pack(side="right")

        self.estado_var = tk.StringVar(value="Sin cargar")
        self.estado = ttk.Label(top, textvariable=self.estado_var, style="Status.TLabel")
        self.estado.pack(side="right", padx=14)

        wrap = ttk.Frame(self, style="Panel.TFrame")
        wrap.pack(fill="both", expand=True, padx=14, pady=(0, 14))

        cols = ("nombre", "jugadores", "modo", "direccion")
        titulos = ("Servidor", "Jugadores", "Modo", "Dirección")
        self.tree = ttk.Treeview(wrap, columns=cols, show="headings")
        for c, t, w in zip(cols, titulos, (400, 100, 170, 160)):
            self.tree.heading(c, text=t)
            self.tree.column(c, width=w, anchor="w")
        self.tree.tag_configure("odd", background=ROW_ODD)
        self.tree.tag_configure("even", background=ROW_EVEN)

        vsb = ttk.Scrollbar(wrap, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.pack(side="left", fill="both", expand=True, padx=(1, 0), pady=1)
        vsb.pack(side="right", fill="y")

        self.tree.bind("<Double-1>", self._copiar)

        self._todas = []

    def _copiar(self, _event):
        sel = self.tree.selection()
        if not sel:
            return
        ip = self.tree.item(sel[0], "values")[3]
        self.clipboard_clear()
        self.clipboard_append(ip)
        self.estado_var.set(f"Copiado: {ip}")

    def _aplicar_filtro(self):
        q = self.filtro.get().lower()
        self.tree.delete(*self.tree.get_children())
        i = 0
        for fila in self._todas:
            if q in fila[0].lower() or q in fila[2].lower():
                self.tree.insert("", "end", values=fila, tags=("odd" if i % 2 else "even",))
                i += 1

    def refrescar(self):
        self.estado_var.set("Cargando...")
        threading.Thread(target=self._cargar, daemon=True).start()

    def _cargar(self):
        try:
            filas = self.fetch_fn()
            filas.sort(key=lambda f: -int(f[1].split("/")[0]) if f[1].split("/")[0].isdigit() else 0)
        except Exception as e:
            mensaje = f"Error: {e}"
            self.after(0, lambda: self.estado_var.set(mensaje))
            return
        self._todas = filas
        self.after(0, lambda: (self._aplicar_filtro(), self.estado_var.set(f"{len(filas)} servidores")))


class ManualTab(ttk.Frame):
    def __init__(self, master, juego, store, is_udp):
        super().__init__(master, style="TFrame")
        self.juego = juego
        self.store = store
        self.is_udp = is_udp
        self._build()

    def _build(self):
        top = ttk.Frame(self)
        top.pack(fill="x", padx=14, pady=(14, 8))
        ttk.Label(top, text="Sin master server público — añade servidores a mano.",
                  style="Dim.TLabel").pack(side="left")
        ttk.Button(top, text="Añadir servidor", style="Accent.TButton",
                   command=self._anadir).pack(side="right")
        ttk.Button(top, text="Comprobar todos", command=self.refrescar).pack(side="right", padx=8)

        wrap = ttk.Frame(self, style="Panel.TFrame")
        wrap.pack(fill="both", expand=True, padx=14, pady=(0, 14))

        cols = ("direccion", "estado")
        self.tree = ttk.Treeview(wrap, columns=cols, show="headings")
        for c, t, w in zip(cols, ("Dirección", "Estado"), (280, 180)):
            self.tree.heading(c, text=t)
            self.tree.column(c, width=w, anchor="w")
        self.tree.tag_configure("odd", background=ROW_ODD)
        self.tree.tag_configure("even", background=ROW_EVEN)

        vsb = ttk.Scrollbar(wrap, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.pack(side="left", fill="both", expand=True, padx=(1, 0), pady=1)
        vsb.pack(side="right", fill="y")
        self.tree.bind("<Delete>", self._borrar)

        self._recargar_tabla()

    def _recargar_tabla(self):
        self.tree.delete(*self.tree.get_children())
        for i, ip in enumerate(self.store.get(self.juego, [])):
            self.tree.insert("", "end", values=(ip, "sin comprobar"),
                              tags=("odd" if i % 2 else "even",))

    def _anadir(self):
        ip = simpledialog.askstring(self.juego, "IP:puerto del servidor (ej. 127.0.0.1:22003)")
        if not ip:
            return
        self.store.setdefault(self.juego, []).append(ip)
        save_manual(self.store)
        self._recargar_tabla()

    def _borrar(self, _event):
        sel = self.tree.selection()
        if not sel:
            return
        ip = self.tree.item(sel[0], "values")[0]
        self.store[self.juego] = [x for x in self.store.get(self.juego, []) if x != ip]
        save_manual(self.store)
        self._recargar_tabla()

    def refrescar(self):
        threading.Thread(target=self._comprobar_todos, daemon=True).start()

    def _comprobar_todos(self):
        for item in list(self.tree.get_children()):
            ip_puerto = self.tree.item(item, "values")[0]
            try:
                ip, puerto = ip_puerto.rsplit(":", 1)
                estado = check_port(ip, int(puerto), is_udp=self.is_udp)
            except Exception:
                estado = "direccion invalida"
            self.after(0, lambda i=item, e=estado: self.tree.set(i, "estado", e))


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("GTA Server List")
        self.geometry("880x560")
        self.minsize(680, 420)

        if ICON_FILE.exists():
            try:
                self.iconbitmap(str(ICON_FILE))
            except Exception:
                pass

        aplicar_estilo(self)

        header = ttk.Frame(self)
        header.pack(fill="x", padx=16, pady=(14, 4))
        ttk.Label(header, text="📡 GTA SERVER LIST", style="Header.TLabel").pack(side="left")
        ttk.Label(header, text="   todos los servidores multijugador de GTA en un solo sitio",
                  style="Sub.TLabel").pack(side="left", pady=(4, 0))

        sep = tk.Frame(self, bg=BORDER, height=1)
        sep.pack(fill="x", padx=16, pady=(8, 0))

        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True, padx=8, pady=8)

        self.tabs = []
        for nombre, fetch_fn in LIVE_GAMES.items():
            tab = ServerTab(nb, fetch_fn)
            nb.add(tab, text=nombre)
            self.tabs.append(tab)

        manual_store = load_manual()
        for juego in MANUAL_GAMES:
            tab = ManualTab(nb, juego, manual_store, is_udp=True)
            nb.add(tab, text=juego)

        for t in self.tabs:
            t.refrescar()


if __name__ == "__main__":
    App().mainloop()
