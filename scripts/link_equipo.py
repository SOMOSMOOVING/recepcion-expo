"""Link del equipo de recorrido (hostess y marketing).

El link lleva la clave del equipo: con ella se ve la lista de presentes del día
y cada uno se anota en los recorridos. La base guarda solo el hash de la clave.

Uso:
    python scripts/link_equipo.py --anio 2027
        Genera una clave nueva, imprime el SQL para guardar su hash en Supabase
        y el link para pasarle al equipo (por WhatsApp, por ejemplo).

Si el link se filtra, se genera otro con este script: el viejo deja de andar
en cuanto se corre el SQL nuevo. Cuando esté la pantalla de recepción (fase 4),
esto también se va a poder hacer desde ahí.
"""

from __future__ import annotations

import argparse
import hashlib
import secrets
import sys

URL_APP = "https://somosmooving.github.io/recepcion-expo/"


def main() -> int:
    # en Windows la consola puede no ser UTF-8: sin esto, "→" o una tilde rompen el script
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--anio", type=int, required=True, help="año de la expo")
    p.add_argument("--url", default=URL_APP, help=f"dirección de la app (por defecto {URL_APP})")
    a = p.parse_args()
    if not 2020 <= a.anio <= 2100:
        p.error("--anio fuera de rango")
    if not a.url.startswith("https://"):
        p.error("--url tiene que empezar con https://")

    clave = secrets.token_hex(16)
    hash_clave = hashlib.sha256(clave.encode("utf-8")).hexdigest()
    print("1) Corré esto en Supabase → SQL Editor (guarda solo el hash de la clave):\n")
    # solo la edición de ese año: no le cambia la clave a otra expo abierta
    print(f"   update public.expo_ediciones set clave_equipo_hash = '{hash_clave}'\n"
          f"    where anio = {a.anio} and estado <> 'cerrada'\n"
          f"    returning anio, estado;\n")
    # el SQL Editor no dice cuántas filas cambió un update: el returning las muestra
    print('   Tiene que mostrar UNA fila con el año. Si dice "Success. No rows returned",\n'
          "   la edición de ese año no existe (ver README: crear la edición) o ya cerró:\n"
          "   no pases el link.\n")
    print("2) Pasale este link al equipo de recorrido (solo a ellos):\n")
    print(f"   {a.url.rstrip('/')}/#equipo={clave}\n")
    print("Cada uno lo abre una vez, elige su nombre y queda guardado en el celular.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
