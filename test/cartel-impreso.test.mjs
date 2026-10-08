// scripts/cartel.py: el cartel A3 con el QR general (lleva la clave del cartel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
