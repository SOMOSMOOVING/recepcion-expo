# Recepción Expo Mooving

Registro de la expo anual sin nadie anotando en la puerta. Reemplaza el Excel de la entrada.

- **App:** un solo `index.html`, sin build ni librerías de UI, publicado en GitHub Pages (fase 2 en adelante).
- **Base:** la misma de Supabase que la app de pedidos. Tablas nuevas con prefijo `expo_`; las de pedidos no se tocan.
- **Diseño:** `diseno/mooving-recepcion.html` (pantallas, estados y componentes) y los logos en `diseno/`.

## Base de datos

Las migraciones están en `sql/expo-migracion-vNN.sql`. Son idempotentes: se pueden correr dos veces.

1. Abrí Supabase → **SQL Editor** y pegá la migración nueva entera.
2. Necesita `public.es_admin()` de la app de pedidos. Si no está, frena con un error.
3. Al final, la sección **VERIFICACIÓN** devuelve tres resultados:
   - todas las tablas `expo_*` con `rls = true`;
   - la lista de funciones que puede ejecutar el anónimo (ninguna empieza con `expo__`);
   - ninguna tabla legible por el anónimo (0 filas).
4. **Siempre se corre el SQL antes de publicar el `index.html`.**

Quién puede hacer qué:

| Quién | Cómo entra | Qué puede |
|---|---|---|
| Cliente | link con su token (QR) | ver su pantalla, confirmar, registrar, corregir la cantidad |
| Cartel de la entrada | sin login | buscar (≥ 3 letras, máx. 8) y alta rápida (con freno) |
| Equipo de recorrido | link con la clave del equipo | ver presentes del día, "Me anoto" / "Me bajo" |
| Recepción | usuario de Supabase con `es_admin()` | todo, por RLS; vincular altas; cambiar la clave del equipo |

El anónimo no lee ni escribe ninguna tabla: solo llama funciones.

## Tests

Requiere Node 22 o más nuevo. npm se usa solo para los tests: no va nada a producción.

```bash
npm install
```

```bash
npm test
```

Los tests corren contra un Postgres de verdad (PGlite) con lo que Supabase trae de fábrica: los roles `anon` y `authenticated`, sus permisos por defecto y `auth.jwt()`. No tocan la base real.

**Prueba de mutación:** saca, una por una, las líneas del SQL que protegen algo y verifica que el test que las cuida falle. Tarda varios minutos.

```bash
npm run mutacion
```

Para correr solo algunas, pasá un filtro con el nombre (por ejemplo `npm run mutacion -- vincular`).

## Revisión automática (viene de la plantilla)

Este repo se creó desde `SOMOSMOOVING/plantilla-app-mooving`. Trae dos cosas:

- **Revisión con Claude en cada Pull Request y en cada push a `main`** (`.github/workflows/claude-review.yml`). Qué revisa está en `.github/claude-review.md`.
- **Controles antes de cada commit** (`.pre-commit-config.yaml` y `ruff.toml`): frenan archivos `.env`, credenciales en el código, la `service_role` de Supabase en el frontend y errores de Python y JS/TS.

Para que anden, una vez:

1. En GitHub: **Settings → Secrets and variables → Actions → New repository secret**, con nombre `CLAUDE_CODE_OAUTH_TOKEN` y como valor el token que da `claude setup-token`.
2. En la compu, dentro de la carpeta del repo: `pre-commit install` (hace falta tener `pre-commit` instalado: `pip install pre-commit`).
