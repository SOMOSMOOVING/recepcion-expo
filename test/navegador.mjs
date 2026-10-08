// Tests de pantalla: la app de verdad (index.html) en Edge o Chrome, con las
// llamadas a Supabase respondidas acá (no se toca la base real).
//
// · El navegador es el que ya está instalado (playwright-core no baja ninguno).
//   EXPO_NAVEGADOR elige: msedge (por defecto) o chrome.
// · EXPO_INDEX reemplaza el index.html servido: lo usa la prueba de mutación.
// · Cada test dice a qué ancho mira (abrir({ ancho })).
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
export const INDEX = process.env.EXPO_INDEX || join(RAIZ, 'index.html');
export const ANCHOS = [320, 360, 375, 390, 412];

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.gif': 'image/gif' };

let servidor, origen, navegador;

async function arrancar() {
  if (origen) return;
  servidor = createServer((req, res) => {
    const ruta = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const archivo = ruta === '/' || ruta === '/index.html' ? INDEX : normalize(join(RAIZ, ruta));
    if ((!archivo.startsWith(RAIZ) && archivo !== INDEX) || !existsSync(archivo)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TIPOS[extname(archivo)] || 'application/octet-stream' });
    res.end(readFileSync(archivo));
  });
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  origen = `http://127.0.0.1:${servidor.address().port}`;
  navegador = await chromium.launch({ channel: process.env.EXPO_NAVEGADOR || 'msedge' });
}

after(async () => {
  await navegador?.close();
  servidor?.close();
});

// Hoy en Argentina, y corrido n días ("2026-10-15").
export const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
export function dia(n) {
  const [a, m, d] = hoy().split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

export const TOKEN = 'a'.repeat(32);
export const CLAVE_CARTEL = 'cafecafecafecafecafecafecafecafe';
export const SIN_RED = Symbol('sin red');

// Respuesta de expo_ver_invitado durante la expo (hoy es el día 2 de 3).
export function enCurso(extra = {}, invitado = {}) {
  return {
    estado: 'en_curso',
    edicion: { anio: 2026, dias: [dia(-1), dia(0), dia(1)], hoy: hoy(), hora_apertura: '09:00:00' },
    invitado: { razon_social: 'MINUCHIN MARTA LILIANA - LIBRERIA PAPELTEC', codigo_erp: '10234', localidad: 'Lanús', ...invitado },
    nombre_credencial: 'LIBRERÍA PAPELTEC',
    turno_hoy: { desde: '10:00:00', hasta: '11:00:00' },
    visita_hoy: null,
    visita_anterior: null,
    ...extra,
  };
}
export function previa(extra = {}) {
  return {
    estado: 'previa',
    edicion: { anio: 2027, dias: [dia(12), dia(13), dia(14)], hoy: hoy(), hora_apertura: '09:00:00' },
    invitado: { razon_social: 'MINUCHIN MARTA LILIANA - LIBRERIA PAPELTEC', codigo_erp: '10234', localidad: 'Lanús' },
    confirmado: null, confirmado_cantidad: null,
    turno: { dia: dia(12), desde: '10:00:00', hasta: '11:00:00' },
    ...extra,
  };
}

/* Abre la app al ancho indicado (obligatorio: el nombre del test lo dice).
   rpc: { nombreFuncion: (args, n) => respuesta | SIN_RED | { error: 'expo_...' } }
   reloj: true para adelantar el tiempo desde el test (lo que se actualiza solo).
   Devuelve la página y las llamadas que hizo ({ fn, args }). */
export async function abrir({ ancho, alto = 800, hash = '', rpc = {}, local = null, oscuro = false, reloj = false } = {}) {
  if (!ancho) throw new Error("abrir(): falta el ancho (cada test dice a qué ancho mira)");
  await arrancar();
  const contexto = await navegador.newContext({
    viewport: { width: ancho, height: alto },
    serviceWorkers: 'block',
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    colorScheme: oscuro ? 'dark' : 'light',
  });
  if (reloj) await contexto.clock.install();   // el test maneja el tiempo (page.clock.fastForward)
  const llamadas = [];
  const veces = {};
  await contexto.route('https://fonts.googleapis.com/**', (r) => r.abort());
  await contexto.route('https://fonts.gstatic.com/**', (r) => r.abort());
  await contexto.route('**/rest/v1/rpc/**', async (ruta) => {
    const fn = ruta.request().url().split('/rpc/')[1];
    const args = JSON.parse(ruta.request().postData() || '{}');
    llamadas.push({ fn, args });
    veces[fn] = (veces[fn] || 0) + 1;
    const manejador = rpc[fn];
    const respuesta = manejador ? await manejador(args, veces[fn]) : { error: 'sin_manejador_' + fn };
    if (respuesta === SIN_RED) return ruta.abort('internetdisconnected');
    if (respuesta && respuesta.error) {
      return ruta.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'P0001', message: respuesta.error }) });
    }
    return ruta.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(respuesta) });
  });
  if (local) {
    await contexto.addInitScript((datos) => {
      if (sessionStorage.getItem('__sembrado')) return;
      sessionStorage.setItem('__sembrado', '1');
      for (const [k, v] of Object.entries(datos)) localStorage.setItem(k, JSON.stringify(v));
    }, local);
  }
  const page = await contexto.newPage();
  page.setDefaultTimeout(10000);   // nada tarda más de 1–2 s: si falla, que no espere 30
  const errores = [];
  page.on('pageerror', (e) => errores.push(e.message));
  await page.goto(`${origen}/index.html${hash}`);
  return { page, llamadas, errores, contexto, origen };
}

// Una visita como la devuelve expo_presentes (n distingue una de otra; las de n más alto llegaron antes).
export function visitaDePrueba(n, razon, extra = {}) {
  return {
    visita_id: `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-000000000000`,
    llegada: new Date(Date.now() - n * 600000).toISOString(), cantidad: 2, razon_social: razon,
    zona: 'Zona Sur', categoria: 'cliente', sin_codigo: false, vendedor: 'Laura Benítez', recorrido: [], ...extra,
  };
}

// Lo que hay en la cola sin señal del celular.
export const cola = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('expoCola') || '[]'));

// Espera la respuesta de una RPC (la primera que cumpla `cumple(args)`) y que la
// página termine de procesarla. Se arma ANTES de la acción que la dispara.
export function respuestaDe(page, fn, cumple = () => true) {
  const respuesta = page.waitForResponse((r) => r.url().endsWith('/rpc/' + fn) && cumple(JSON.parse(r.request().postData() || '{}')));
  return respuesta.then(() => page.evaluate(() => new Promise((ok) => setTimeout(ok, 0))));
}

// ¿La página pide `fn` en el próximo segundo? (null si no). Se arma ANTES de la acción.
export const pideEnUnSegundo = (page, fn) =>
  page.waitForRequest((r) => r.url().endsWith('/rpc/' + fn), { timeout: 1000 }).catch(() => null);

// Simula que volvió la señal (sin esperar el reintento programado).
export const vuelveLaSenal = (page) => page.evaluate(() => window.dispatchEvent(new Event('online')));

// ¿Algo se sale del ancho de la pantalla? Devuelve qué.
export function desbordes(page) {
  return page.evaluate(() => {
    const ancho = document.documentElement.clientWidth;
    const fuera = [];
    if (document.documentElement.scrollWidth > ancho) fuera.push(`la página scrollea de costado (${document.documentElement.scrollWidth} > ${ancho})`);
    for (const el of document.querySelectorAll('#app *')) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > ancho + 0.5 || r.left < -0.5)) fuera.push(`${el.tagName.toLowerCase()}.${el.className} (${Math.round(r.left)}–${Math.round(r.right)})`);
    }
    return fuera;
  });
}
