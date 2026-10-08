// Controles sobre los archivos de la app (sin navegador).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const leer = (f) => readFileSync(join(RAIZ, f), 'utf8');
const INDEX = process.env.EXPO_INDEX ? readFileSync(process.env.EXPO_INDEX, 'utf8') : leer('index.html');

// La versión se lee del index.html: no se escribe a mano en los tests.
const APP_VERSION = (INDEX.match(/const APP_VERSION = "([^"]+)"/) || [])[1];

test('APP_VERSION está en el index.html', () => {
  assert.ok(APP_VERSION, 'no se encontró APP_VERSION en index.html');
});

test('el service worker tiene la misma versión que la app (si no, el celular se queda con la vieja)', () => {
  const sw = (leer('sw.js').match(/const VERSION = "([^"]+)"/) || [])[1];
  assert.equal(sw, APP_VERSION);
});

test('el service worker guarda los logos que usa la app (si se cambia el logo, sin señal no aparecería)', () => {
  const logos = [...INDEX.match(/const LOGO = \{([^}]*)\}/)[1].matchAll(/"([^"]+)"/g)].map((m) => './' + m[1]);
  const shell = leer('sw.js').match(/const SHELL = \[([^\]]*)\]/)[1];
  for (const l of logos) assert.ok(shell.includes(`"${l}"`), `sw.js no guarda ${l}`);
});

test('el CSS del diseño (tokens.css y bundle.css) está copiado tal cual, sin el andamiaje mr-demo', () => {
  const lineas = leer('diseno/mooving-recepcion.html').split('\n');
  const desde = lineas.findIndex((l) => l.startsWith('/* ===== tokens.css'));
  const hasta = lineas.findIndex((l) => l.includes('Andamiaje de vistas previas'));
  const diseno = lineas.slice(desde, hasta).join('\n').trim();
  assert.ok(diseno.length > 1000);
  assert.ok(INDEX.replace(/\r\n/g, '\n').includes(diseno), 'el CSS del index.html no es el del diseño');
  assert.doesNotMatch(INDEX, /\.mr-demo/);
});

test('en la página va solo la clave publicable de Supabase, nunca la service_role', () => {
  assert.doesNotMatch(INDEX, /service_role/i);
  assert.match(INDEX, /const SB_KEY = "sb_publishable_/);
  assert.doesNotMatch(INDEX, /sb_secret_/);
});

