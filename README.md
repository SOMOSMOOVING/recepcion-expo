# Plantilla de apps — Mooving

Cada app que se cree desde esta plantilla ya trae:

- **Revisión automática con Claude** en cada Pull Request y cada push a `main`
  (`.github/workflows/claude-review.yml`). Qué revisa: `.github/claude-review.md`.
- **Controles antes de cada commit** (`.pre-commit-config.yaml` + `ruff.toml`):
  frena archivos `.env`, credenciales en el código, la `service_role` de Supabase
  en el frontend y errores de Python y JS/TS.

## Al crear una app nueva desde esta plantilla

1. Settings → Secrets and variables → Actions → New repository secret
   - Nombre: `CLAUDE_CODE_OAUTH_TOKEN`
   - Valor: el token que da `claude setup-token`
   (Si el repo está en una organización con el secret ya cargado, no hace falta.)
2. En tu compu, dentro de la carpeta del repo: `pre-commit install`
   (no hace falta si configuraste `init.templateDir` global).

Borrá o reemplazá este README por el de tu app.
