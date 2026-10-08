// scripts/cartel.py: el cartel A3 con el QR general (lleva la clave del cartel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base, anon } from './db.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const python = (...args) => spawnSync('python', ['scripts/cartel.py', ...args], { cwd: RAIZ, encoding: 'utf8' });
const haySegno = spawnSync('python', ['-c', 'import segno'], { encoding: 'utf8' }).status === 0;

test('el SQL que imprime guarda el hash de la clave que va en el QR (nunca la clave)', { skip: !haySegno && 'falta segno: pip install -r scripts/requirements.txt' }, (t) => {
  // en una carpeta temporal: no pisa el cartel de verdad (cartel/)
  const dir = mkdtempSync(join(tmpdir(), 'expo-cartel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const salida = join(dir, 'cartel.html');
  const r = python('--anio', '2027', '--salida', salida);
  assert.equal(r.status, 0, r.stderr);
  const clave = r.stdout.match(/^\s+([0-9a-f]{32})\s*$/m)[1];
  const hash = r.stdout.match(/clave_cartel_hash = '([0-9a-f]{64})'/)[1];
  assert.equal(hash, createHash('sha256').update(clave).digest('hex'));
  assert.match(r.stdout, /where anio = 2027 and estado <> 'cerrada'/, 'el update le cambiaría la clave a otra expo abierta');
  const cartel = readFileSync(salida, 'utf8');
  assert.match(cartel, /<svg/);
  assert.match(cartel, /Expo Mooving 2027 · Registro/);
  assert.doesNotMatch(cartel, new RegExp(clave), 'la clave quedó escrita en el HTML (solo tiene que ir dentro del QR)');
});

test('una clave mal escrita no arma el cartel', { skip: !haySegno && 'falta segno' }, () => {
  const r = python('--anio', '2027', '--clave', 'no-es-una-clave', '--salida', join(tmpdir(), 'expo-no-se-escribe.html'));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /32 caracteres hexadecimales/);
});

test('link del equipo: el SQL guarda el hash de la clave que va en el link, solo en la edición de ese año', () => {
  const r = spawnSync('python', ['scripts/link_equipo.py', '--anio', '2027'], { cwd: RAIZ, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const clave = r.stdout.match(/#equipo=([0-9a-f]{32})/)[1];
  const hash = r.stdout.match(/clave_equipo_hash = '([0-9a-f]{64})'/)[1];
  assert.equal(hash, createHash('sha256').update(clave).digest('hex'));
  assert.match(r.stdout, /where anio = 2027 and estado <> 'cerrada'/);
});

test('la carpeta de carteles no se sube al repo (tienen la clave adentro)', () => {
  assert.match(readFileSync(join(RAIZ, '.gitignore'), 'utf8'), /^cartel\/$/m);
});

// El SQL Editor no dice cuántas filas cambió un update: el que imprimen los
// scripts tiene que DEVOLVER la fila, así se ve si la edición existía.
const elUpdate = (salida) => salida.match(/update public\.expo_ediciones[\s\S]*?;/)[0];

test('el SQL de los scripts muestra la fila que cambió (y ninguna si la edición no existe)', { skip: !haySegno && 'falta segno' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'expo-cartel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const equipo = (anio) => spawnSync('python', ['scripts/link_equipo.py', '--anio', anio], { cwd: RAIZ, encoding: 'utf8' }).stdout;
  const cartel = (anio) => python('--anio', anio, '--salida', join(dir, `c${anio}.html`)).stdout;

  // la base de prueba tiene la edición 2026 abierta; la 2027 no existe
  for (const imprimir of [equipo, cartel]) {
    const { db } = await base();
    const r = await db.query(elUpdate(imprimir('2026')));
    assert.deepEqual(r.rows.map((f) => f.anio), [2026], 'no muestra la fila que cambió');
    const { db: otra } = await base();
    assert.equal((await otra.query(elUpdate(imprimir('2027')))).rows.length, 0);
  }

  // y la clave que imprimen es la que después anda
  const { db } = await base();
  const salidaEquipo = equipo('2026'), salidaCartel = cartel('2026');
  await db.query(elUpdate(salidaEquipo));
  await db.query(elUpdate(salidaCartel));
  await anon(db, 'expo_equipo_lista', salidaEquipo.match(/#equipo=([0-9a-f]{32})/)[1]);   // con una clave que no anda, tira error
  await anon(db, 'expo_buscar', salidaCartel.match(/^\s+([0-9a-f]{32})\s*$/m)[1], 'pap');
});
