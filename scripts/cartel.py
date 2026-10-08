"""Cartel de la entrada (A3) con el QR general de registro.

El QR lleva la clave del cartel: sin ella la base no deja buscar ni dar de
alta, así nadie de afuera saca el link personal de un cliente buscándolo por
nombre. La base guarda solo el hash de la clave.

Uso:
    python scripts/cartel.py --anio 2027
        Genera una clave nueva, imprime el SQL para guardar su hash en Supabase
        y arma cartel/cartel-expo-2027.html para imprimir.
    python scripts/cartel.py --anio 2027 --clave <la misma de antes>
        Vuelve a armar el mismo cartel (por ejemplo, para reimprimirlo).

Imprimir: abrir el .html en Chrome o Edge → Imprimir → tamaño A3, márgenes
"Ninguno", con "Gráficos de fondo" activado.

La carpeta cartel/ no se sube al repo (está en .gitignore): el cartel tiene la
clave adentro.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import mimetypes
import re
import secrets
import sys
from pathlib import Path

import segno

RAIZ = Path(__file__).resolve().parent.parent
URL_APP = "https://somosmooving.github.io/recepcion-expo/"
CLAVE_RE = re.compile(r"^[0-9a-f]{32}$")

# El cartel del diseño mide 420 px de ancho (vista previa); A3 son 297 mm.
ANCHO_DISENO_PX = 420
ZOOM_A3 = round(297 / 25.4 * 96 / ANCHO_DISENO_PX, 3)


def css_del_diseno() -> str:
    """tokens.css y bundle.css, tal cual están en el index.html."""
    index = (RAIZ / "index.html").read_text(encoding="utf-8")
    desde = index.index("/* ===== tokens.css")
    hasta = index.index("/* ===== propio de la app")
    return index[desde:hasta]


def logo_claro() -> str:
    """El logo claro como data URI: el cartel es papel, siempre claro.

    Sale de LOGO en el index.html: cambiar el logo (por ejemplo al GIF) es
    tocar un solo lugar.
    """
    index = (RAIZ / "index.html").read_text(encoding="utf-8")
    encontrado = re.search(r'const LOGO = \{ claro: "([^"]+)"', index)
    if not encontrado:
        sys.exit('No encontré el logo en index.html: tiene que haber una línea const LOGO = { claro: "..." }')
    ruta = encontrado.group(1)
    tipo = mimetypes.guess_type(ruta)[0] or "image/png"
    datos = (RAIZ / ruta).read_bytes()
    return f"data:{tipo};base64," + base64.b64encode(datos).decode("ascii")


def armar_cartel(url_qr: str, anio: int) -> str:
    qr = segno.make(url_qr, error="m")
    svg = qr.svg_inline(dark="#17141d", border=0, omitsize=True)
    return f"""<!doctype html>
<html lang="es" data-theme="light">
<head>
<meta charset="utf-8">
<title>Cartel de registro · Expo Mooving {anio}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap">
<style>
{css_del_diseno()}
@page {{ size: A3; margin: 0; }}
html, body {{ margin: 0; background: #ffffff; }}
.hoja {{ width: {ANCHO_DISENO_PX}px; zoom: {ZOOM_A3}; }}
.mr-cartel {{ border-radius: 0; }}
@media screen {{ body {{ background: #e7e4ec; padding: 24px; }} .hoja {{ zoom: 1.4; margin: 0 auto; }} }}
</style>
</head>
<body>
<div class="hoja"><div class="mr-cartel"><div class="mr-cartel-cuerpo">
<p class="mr-cartel-marca"><img src="{logo_claro()}" alt="Mooving"></p>
<h2 class="mr-cartel-titulo">¿No trajiste<br>tu QR?</h2>
<div class="mr-cartel-qr" role="img" aria-label="QR de registro">{svg}</div>
<p class="mr-cartel-pasos">Escaneá este con la cámara del celular,<br>buscá tu empresa y tocá <b>Estoy acá</b>.</p>
<p class="mr-cartel-pie">Expo Mooving {anio} · Registro</p>
</div></div></div>
</body>
</html>
"""


def main() -> int:
    # en Windows la consola puede no ser UTF-8: sin esto, "→" o una tilde rompen el script
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--anio", type=int, required=True, help="año de la expo (va en el pie del cartel)")
    p.add_argument("--clave", help="clave del cartel ya generada (32 caracteres hexadecimales)")
    p.add_argument("--url", default=URL_APP, help=f"dirección de la app (por defecto {URL_APP})")
    p.add_argument("--salida", type=Path, help="dónde escribir el cartel (por defecto cartel/cartel-expo-AAAA.html)")
    a = p.parse_args()

    if not 2020 <= a.anio <= 2100:
        p.error("--anio fuera de rango")
    if not a.url.startswith("https://"):
        p.error("--url tiene que empezar con https://")
    nueva = a.clave is None
    clave = secrets.token_hex(16) if nueva else a.clave.strip().lower()
    if not CLAVE_RE.match(clave):
        p.error("--clave tiene que tener 32 caracteres hexadecimales (0-9, a-f)")

    url_qr = a.url.rstrip("/") + "/#cartel=" + clave
    salida = a.salida or RAIZ / "cartel" / f"cartel-expo-{a.anio}.html"
    salida.parent.mkdir(parents=True, exist_ok=True)
    salida.write_text(armar_cartel(url_qr, a.anio), encoding="utf-8")

    hash_clave = hashlib.sha256(clave.encode("utf-8")).hexdigest()
    print(f"Cartel listo: {salida}")
    if nueva:
        print("\n1) Corré esto en Supabase → SQL Editor (guarda solo el hash de la clave):\n")
        # solo la edición de ese año: no le cambia la clave a otra expo abierta
        print(f"   update public.expo_ediciones set clave_cartel_hash = '{hash_clave}'\n"
              f"    where anio = {a.anio} and estado <> 'cerrada'\n"
              f"    returning anio, estado;\n")
        # el SQL Editor no dice cuántas filas cambió un update: el returning las muestra
        print('   Tiene que mostrar UNA fila con el año. Si dice "Success. No rows returned",\n'
              "   la edición de ese año no existe (ver README: crear la edición) o ya cerró:\n"
              "   no imprimas el cartel.\n")
        print("2) Guardá la clave por si hay que reimprimir el mismo cartel (no la subas a ningún lado):\n")
        print(f"   {clave}\n")
        print("Si la clave se filtra, generá otra con este script y reimprimí: la vieja deja de andar.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
