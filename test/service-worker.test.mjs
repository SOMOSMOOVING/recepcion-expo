// sw.js de verdad, en el navegador: lo que guarda y lo que borra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrir } from './navegador.mjs';

// Espera a que el service worker nuevo tome la página (después de su "activate").
const controlada = (page) => page.evaluate(() => new Promise((ok) => (
  navigator.serviceWorker.controller ? ok() : navigator.serviceWorker.addEventListener('controllerchange', ok))));

test('360 px · el service worker borra solo sus versiones viejas: los cachés de la app de pedidos (mismo sitio) quedan', async () => {
  const { page, contexto } = await abrir({
    ancho: 360, sw: true, rpc: {},
    antes: (p) => p.evaluate(async () => {
      await caches.open('pedidos-mooving-v28');   // la app de pedidos, en somosmooving.github.io igual que esta
      await caches.open('recepcion-expo-v0');     // una versión vieja de esta app
    }),
  });
  await controlada(page);
  const claves = await page.evaluate(() => caches.keys());
  assert.ok(claves.includes('pedidos-mooving-v28'), `borró el caché de la app de pedidos (${claves})`);
  assert.ok(!claves.includes('recepcion-expo-v0'), `no borró la versión vieja (${claves})`);
  assert.ok(claves.some((k) => k.startsWith('recepcion-expo-')), `no guardó la app (${claves})`);
  await contexto.close();
});
