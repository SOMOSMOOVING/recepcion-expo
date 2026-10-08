// La frontera es el RLS y los permisos, no la app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base, como, anon, admin, rpc, uno, ADMIN, VENDEDOR, leerMigraciones, archivosMigracion } from './db.mjs';
import { readFileSync } from 'node:fs';

async function tablasExpo(db) {
  const r = await db.query(`
    select relname from pg_class
     where relnamespace = 'public'::regnamespace and relkind = 'r' and relname like 'expo\\_%'
     order by 1`);
  return r.rows.map((f) => f.relname);
}

test('el anónimo no puede leer ninguna tabla expo_ (ni vacía: permiso denegado)', async () => {
  const { db } = await base();
  const tablas = await tablasExpo(db);
  assert.ok(tablas.includes('expo_invitados') && tablas.includes('expo_visitas'));
  for (const t of tablas) {
    await assert.rejects(
      como(db, 'anon', {}, (tx) => tx.query(`select * from public.${t} limit 1`)),
      /permission denied/,
      `anon pudo leer ${t}`);
  }
});

test('el anónimo no puede escribir en las tablas', async () => {
  const { db, s } = await base();
  await assert.rejects(
    como(db, 'anon', {}, (tx) => tx.query(
      `insert into public.expo_visitas (invitado_id, dia, cantidad) values ($1, expo_hoy(), 2)`,
      [s.papeltec.id])),
    /permission denied/);
  await assert.rejects(
    como(db, 'anon', {}, (tx) => tx.query(`update public.expo_invitados set confirmado = true`)),
    /permission denied/);
});

test('un usuario logueado que no es admin no ve ni toca nada (RLS)', async () => {
  const { db, s } = await base();
  for (const t of await tablasExpo(db)) {
    const n = await como(db, 'authenticated', VENDEDOR,
      async (tx) => (await tx.query(`select count(*)::int as n from public.${t}`)).rows[0].n);
    assert.equal(n, 0, `un no admin ve filas de ${t}`);
  }
  await assert.rejects(
    como(db, 'authenticated', VENDEDOR, (tx) => tx.query(
      `insert into public.expo_visitas (invitado_id, dia, cantidad) values ($1, expo_hoy(), 2)`,
      [s.papeltec.id])),
    /row-level security/);
});

test('nadie logueado puede vaciar una tabla con TRUNCATE (el RLS no lo frena)', async () => {
  const { db } = await base();
  for (const t of await tablasExpo(db)) {
    await assert.rejects(
      como(db, 'authenticated', ADMIN, (tx) => tx.query(`truncate public.${t} cascade`)),
      /permission denied/, `se pudo vaciar ${t}`);
  }
});

test('recepción (es_admin) ve los invitados', async () => {
  const { db } = await base();
  const n = await como(db, 'authenticated', ADMIN,
    async (tx) => (await tx.query(`select count(*)::int as n from public.expo_invitados`)).rows[0].n);
  assert.ok(n > 0);
});

test('el anónimo solo puede ejecutar las funciones públicas', async () => {
  const { db } = await base();
  const r = await db.query(`
    select proname from pg_proc
     where pronamespace = 'public'::regnamespace and proname like 'expo\\_%'
       and has_function_privilege('anon', oid, 'execute')
     order by 1`);
  assert.deepEqual(r.rows.map((f) => f.proname).sort(), [
    'expo_alta_rapida', 'expo_anotarme', 'expo_bajarme', 'expo_buscar',
    'expo_confirmar', 'expo_corregir_cantidad', 'expo_equipo_lista',
    'expo_presentes', 'expo_registrar_visita', 'expo_tome_pedido', 'expo_ver_invitado',
  ].sort());
});

test('las funciones internas (devuelven filas enteras) no son públicas', async () => {
  const { db, s } = await base();
  await assert.rejects(anon(db, 'expo__por_token', s.papeltec.token), /permission denied/);
  await assert.rejects(anon(db, 'expo__edicion_por_clave', 'x'), /permission denied/);
  await assert.rejects(anon(db, 'expo__edicion_del_cartel', 'x'), /permission denied/);
});

test('vincular, marcar y cambiar la clave: solo recepción', async () => {
  const { db } = await base();
  const alta = await uno(db, `
    insert into expo_invitados (edicion_id, razon_social, origen, estado_vinculo)
    select id, 'Marroquinería Kalu', 'alta_puerta', 'pendiente' from expo_ediciones returning id`);
  for (const [fn, args] of [['expo_vincular', [alta, '10234']],
                            ['expo_marcar_alta', [alta, 'no_cliente']],
                            ['expo_nueva_clave_equipo', []],
                            ['expo_nueva_clave_cartel', []]]) {
    await assert.rejects(rpc(db, 'anon', {}, fn, args), /permission denied/, `anon: ${fn}`);
    await assert.rejects(rpc(db, 'authenticated', VENDEDOR, fn, args), /expo_solo_admin/, `no admin: ${fn}`);
  }
  assert.equal(await uno(db, `select estado_vinculo from expo_invitados where id = $1`, [alta]), 'pendiente');
});

test('un token mal formado o inexistente no muestra nada', async () => {
  const { db } = await base();
  for (const t of ['', 'x', "' or 1=1 --", 'f'.repeat(32), 'F'.repeat(32), null]) {
    assert.deepEqual(await anon(db, 'expo_ver_invitado', t), { estado: 'invalido' });
  }
});

test('ver_invitado devuelve solo lo que muestra la pantalla', async () => {
  const { db, s } = await base();
  const r = await anon(db, 'expo_ver_invitado', s.papeltec.token);
  assert.deepEqual(Object.keys(r.invitado).sort(), ['codigo_erp', 'localidad', 'razon_social']);
  const todo = JSON.stringify(r);
  assert.ok(!todo.includes(s.papeltec.token), 'devuelve el token');
  assert.ok(!todo.includes('Juan Pérez'), 'devuelve el vendedor durante la expo');
  assert.ok(!todo.includes('Zona Sur'), 'devuelve la zona');
});

test('las claves del equipo y del cartel no se guardan: solo su hash', async () => {
  const { db } = await base();
  for (const [fn, col] of [['expo_nueva_clave_equipo', 'clave_equipo_hash'],
                           ['expo_nueva_clave_cartel', 'clave_cartel_hash']]) {
    const clave = await admin(db, fn);
    assert.match(clave, /^[0-9a-f]{32}$/);
    const guardado = await uno(db, `select ${col} from expo_ediciones`);
    assert.notEqual(guardado, clave, col);
    assert.match(guardado, /^[0-9a-f]{64}$/, col);
  }
});

// El bloque de VERIFICACIÓN del final de la migración: en el SQL Editor solo
// se ve la última consulta, así que si algo quedó abierto tiene que FRENAR.
// (La prueba de mutación lo saca del SQL mutado, salvo cuando lo muta a él:
// entonces se usa el del archivo de verdad.)
const BLOQUE = /do \$verificacion\$[\s\S]*?\$verificacion\$;/;
const VERIFICACION = (leerMigraciones().at(-1).match(BLOQUE)
  || readFileSync(archivosMigracion().at(-1), 'utf8').match(BLOQUE))[0];

test('la verificación de la migración frena si algo quedó abierto', async () => {
  const { db } = await base();
  await db.exec(VERIFICACION);   // la migración tal cual pasa
  const sabotajes = [
    [`alter table public.expo_visitas disable row level security`, /sin RLS: expo_visitas/],
    [`grant select on public.expo_invitados to anon`, /el anónimo puede tocar estas tablas: expo_invitados/],
    [`grant insert on public.expo_visitas to anon`, /el anónimo puede tocar estas tablas: expo_visitas/],
    [`grant truncate on public.expo_visitas to authenticated`, /logueado puede vaciar estas tablas: expo_visitas/],
    [`grant execute on function public.expo_vincular(uuid, text) to anon`, /no son públicas: expo_vincular/],
    [`revoke execute on function public.expo_buscar(text, text) from anon, authenticated`, /le faltan funciones .*: expo_buscar/],
    [`grant execute on function public.expo__por_token(text) to authenticated`, /funciones internas: expo__por_token/],
  ];
  for (const [sabotaje, error] of sabotajes) {
    const { db } = await base();
    await db.exec(sabotaje);
    await assert.rejects(db.exec(VERIFICACION), error, sabotaje);
  }
});
