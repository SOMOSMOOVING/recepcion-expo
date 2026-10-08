# Rúbrica de revisión automática

Este archivo lo lee Claude en cada revisión automática (GitHub Actions).
Editalo si querés cambiar qué se revisa: el workflow no hace falta tocarlo.

## Reglas generales

- Revisá **sólo lo que cambió** en el diff indicado, pero leé el archivo entero alrededor de cada cambio para entender el contexto.
- Nunca modifiques código ni hagas commits: sólo comentás.
- Escribí en español, claro y concreto. Nada de elogios ni relleno.
- No informes gustos de estilo como si fueran errores.
- Antes de informar un hallazgo, intentá demostrar que NO es un problema. Si no se sostiene, descartalo.
- Marcá cada hallazgo como **Confirmado** (se ve el escenario concreto) o **Probable** (depende de datos o configuración que no se ven en el repo).
- Si hay archivos Python modificados, corré `ruff check` sobre esos archivos y usá la salida como insumo.

## Pasada A — Correctitud y seguridad

### Datos y números (Python, SQL, pandas)
- Montos con `float` donde importa el centavo → `Decimal` o redondear sólo al final.
- Formatos argentinos mal parseados: `1.234,56`, fechas `dd/mm/aaaa` leídas como `mm/dd`.
- Fechas sin zona horaria o en UTC cuando corresponde `America/Argentina/Buenos_Aires`.
- `merge`/`JOIN` que duplican filas (claves no únicas) o pierden filas (`inner` donde iba `left`); `groupby` que descarta `NaN`.
- Rangos de fechas con bordes mal puestos (`<` vs `<=`, último día del mes).
- Falta de control de cuadre: el total procesado tiene que coincidir con el total de origen.
- Errores tragados: `except: pass`, `except Exception` sin log, valores por defecto que esconden fallas.

### Finnegans / APIs
- Credenciales, tokens o secrets escritos en el código.
- Fechas que no van en `yyyy-mm-dd`.
- Reportes consultados dentro de loops o repetidos (consumen cupo mensual).
- Escrituras sin vista previa ni confirmación.
- Sin manejo de paginación, timeouts o reintentos.

### Apps y páginas web (HTML/JS/TS, Supabase)
- Clave `service_role` o secretos en el frontend (sólo puede ir la `anon`/publishable key).
- Tablas sin RLS o con políticas demasiado abiertas (`using (true)` para escritura). Revisá las migraciones en `supabase/`.
- Datos personales de clientes (mails, teléfonos, CUIT) expuestos a quien no debería verlos.
- QR, links o IDs adivinables (correlativos) que permiten ver o marcar registros de otro cliente.
- Inputs sin validar; `innerHTML` con datos del usuario (XSS).
- Acciones duplicables (doble check-in, doble pedido) sin restricción única o idempotencia.
- Qué pasa sin conexión o con wifi inestable: errores silenciosos, datos perdidos.
- Modo TEST o funciones de prueba visibles en producción.

## Pasada B — Calidad y mantenibilidad

- Código repetido que debería ser una función; funciones largas que hacen varias cosas.
- Números y textos mágicos (IDs de cuentas, bancos, rutas absolutas) → constantes o configuración.
- Nombres poco claros (`df2`, `tmp`, `data_final_final`).
- Lectura, cálculo y exportación mezclados; lógica de negocio metida en componentes de UI.
- Tipos demasiado genéricos: `Any`, `dict` sin estructura, `Record<string, unknown>`, `as` encadenados, parámetros `object`.
- Código muerto, prints de debug, comentarios que no coinciden con el código.
- En páginas: contraste, botones chicos en celular, formularios sin labels, layout que se rompe a ancho de teléfono.

## Gravedad

- 🔴 **Crítico**: da un resultado mal, pierde datos o expone información.
- 🟠 **Alto**: va a fallar en un caso real probable.
- 🟡 **Medio**: problema de mantenimiento o caso borde menos probable.
- ⚪ **Bajo**: mejora menor.

## Formato de cada hallazgo

```
🔴 Crítico · Pasada A · Confirmado
archivo.py:42 — Qué pasa, con un ejemplo concreto
(ej.: "si el extracto trae 1.234,56 se lee como 1.23456").
Cómo arreglarlo: fragmento corregido si es corto.
```

## Resumen final

Empezá con 2-3 líneas: si está listo para usar o no, y lo más urgente.
Después los hallazgos de más grave a menos grave.
Al final, en una línea, lo que no pudiste revisar.
Si no encontraste nada relevante, decilo en una sola línea.
