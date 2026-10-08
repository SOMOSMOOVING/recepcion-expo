// Equipo de recorrido: link con clave, "Me anoto" / "Me bajo".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base, anon, admin, uno, CLAVE_EQUIPO } from './db.mjs';

test('"su vendedor" nunca se guarda como recorrido', async () => {
  const { db, s } = await base();
  // 1. no hay columna de texto donde escribirlo
  const cols = (await db.query(`
    select column_name, data_type from information_schema.columns
     where table_schema = 'public' and table_name = 'expo_recorridos'`)).rows;
  assert.deepEqual(cols.filter((c) => /char|text/.test(c.data_type)), [], 'expo_recorridos tiene una columna de texto');
  // 2. el equipo es solo hostess o marketing: un vendedor no entra
  await assert.rejects(
    db.query(`insert into expo_equipo (nombre, rol) values ('Juan Pérez', 'vendedor')`),
    /expo_equipo_rol/);
  // 3. anotarse con alguien que no es del equipo no anda
  await anon(db, 'expo_registrar_visita', s.papeltec.token, 2);
  const visita = await uno(db, `select id from expo_visitas where invitado_id = $1`, [s.papeltec.id]);
  await assert.rejects(
    anon(db, 'expo_anotarme', CLAVE_EQUIPO, s.papeltec.id, visita),
    /expo_equipo_invalido/);
  // 4. lo normal (nadie se anotó) es no tener filas
  assert.equal(await uno(db, `select count(*)::int from expo_recorridos`), 0);
  const p = await anon(db, 'expo_presentes', CLAVE_EQUIPO, s.equipo.sofia);
  assert.deepEqual(p.presentes[0].recorrido, []);
  assert.equal(p.presentes[0].vendedor, 'Juan Pérez');
});

test('presentes del día, los últimos arriba, con su recorrido', async () => {
  const { db, s } = await base();
  await anon(db, 'expo_registrar_visita', s.papeltec.token, 2);
  await anon(db, 'expo_registrar_visita', s.trebol.token, 3);
  await db.query(`update expo_visitas set llegada = llegada - interval '1 hour' where invitado_id = $1`, [s.papeltec.id]);
  // una visita de ayer no aparece hoy
  await db.query(`insert into expo_visitas (invitado_id, dia, cantidad) values ($1, expo_hoy() - 1, 1)`, [s.lujan.id]);

  const trebol = await uno(db, `select id from expo_visitas where invitado_id = $1`, [s.trebol.id]);
  await anon(db, 'expo_anotarme', CLAVE_EQUIPO, s.equipo.ana, trebol);

  const p = await anon(db, 'expo_presentes', CLAVE_EQUIPO, s.equipo.sofia);
  assert.deepEqual(p.presentes.map((x) => x.razon_social),
    ['GONZALEZ HNOS S.A. - JUGUETERIA EL TREBOL', 'MINUCHIN MARTA LILIANA - LIBRERIA PAPELTEC']);
  assert.deepEqual(p.presentes[0].recorrido.map((r) => r.nombre), ['Ana López']);
  assert.equal(p.presentes[0].cantidad, 3);
  assert.ok(!JSON.stringify(p).includes(s.papeltec.token), 'expone tokens de clientes');
});

test('me anoto, me anoto de nuevo (reintento) y me bajo dos veces: nada se rompe ni duplica', async () => {
  const { db, s } = await base();
  await anon(db, 'expo_registrar_visita', s.papeltec.token, 2);
  const visita = await uno(db, `select id from expo_visitas`);
  await anon(db, 'expo_anotarme', CLAVE_EQUIPO, s.equipo.sofia, visita);
  await anon(db, 'expo_anotarme', CLAVE_EQUIPO, s.equipo.sofia, visita);
  await anon(db, 'expo_anotarme', CLAVE_EQUIPO, s.equipo.ana, visita);
  assert.equal(await uno(db, `select count(*)::int from expo_recorridos`), 2);
  await anon(db, 'expo_bajarme', CLAVE_EQUIPO, s.equipo.sofia, visita);
  await anon(db, 'expo_bajarme', CLAVE_EQUIPO, s.equipo.sofia, visita);
  assert.equal(await uno(db, `select count(*)::int from expo_recorridos`), 1);
});

test('"Tomé el pedido": solo quien se anotó; se marca, se ve y se deshace', async () => {
  const { db, s } = await base();
  await anon(db, 'expo_registrar_visita', s.papeltec.token, 2);
  const visita = await uno(db, `select id from expo_visitas`);
  // sin anotarse no se puede (y el vendedor nunca marca nada: no está en el equipo)
  await assert.rejects(anon(db, 'expo_tome_pedido', CLAVE_EQUIPO, s.equipo.sofia, visita, true), /expo_no_anotado/);

  await anon(db, 'expo_anotarme', CLAVE_EQUIPO, s.equipo.sofia, visita);
  await anon(db, 'expo_anotarme', CLAVE_EQUIPO, s.equipo.ana, visita);
  await anon(db, 'expo_tome_pedido', CLAVE_EQUIPO, s.equipo.sofia, visita, true);
  const p = await anon(db, 'expo_presentes', CLAVE_EQUIPO, s.equipo.ana);
  assert.deepEqual(p.presentes[0].recorrido.map((r) => [r.nombre, r.tomo_pedido]),
    [['Sofía Giménez', true], ['Ana López', false]]);

  await anon(db, 'expo_tome_pedido', CLAVE_EQUIPO, s.equipo.sofia, visita, false);
  assert.equal(await uno(db, `select count(*)::int from expo_recorridos where tomo_pedido`), 0);
  await assert.rejects(anon(db, 'expo_tome_pedido', CLAVE_EQUIPO, s.equipo.sofia, visita, null), /expo_falta_respuesta/);
});

test('"Tomé el pedido" con la expo cerrada o con otra clave no anda', async () => {
  const { db, s } = await base();
  await anon(db, 'expo_registrar_visita', s.papeltec.token, 2);
  const visita = await uno(db, `select id from expo_visitas`);
  await anon(db, 'expo_anotarme', CLAVE_EQUIPO, s.equipo.sofia, visita);
  await assert.rejects(anon(db, 'expo_tome_pedido', 'f'.repeat(32), s.equipo.sofia, visita, true), /expo_clave_invalida/);
  await db.query(`update expo_ediciones set estado = 'previa'`);
  await assert.rejects(anon(db, 'expo_tome_pedido', CLAVE_EQUIPO, s.equipo.sofia, visita, true), /expo_no_es_dia_de_expo/);
  assert.equal(await uno(db, `select count(*)::int from expo_recorridos where tomo_pedido`), 0);
});

test('una clave equivocada no ve nada', async () => {
  const { db, s } = await base();
  for (const c of ['', 'x', 'f'.repeat(32), null, CLAVE_EQUIPO.toUpperCase()]) {
    await assert.rejects(anon(db, 'expo_equipo_lista', c), /expo_clave_invalida/, String(c));
    await assert.rejects(anon(db, 'expo_presentes', c, s.equipo.sofia), /expo_clave_invalida/, String(c));
  }
});

test('cuando la expo cierra, la clave deja de andar', async () => {
  const { db, s } = await base();
  await db.query(`update expo_ediciones set estado = 'cerrada'`);
  await assert.rejects(anon(db, 'expo_presentes', CLAVE_EQUIPO, s.equipo.sofia), /expo_clave_invalida/);
});

test('recepción cambia la clave: la vieja deja de andar en el acto', async () => {
  const { db, s } = await base();
  const nueva = await admin(db, 'expo_nueva_clave_equipo');
  await assert.rejects(anon(db, 'expo_presentes', CLAVE_EQUIPO, s.equipo.sofia), /expo_clave_invalida/);
  assert.equal((await anon(db, 'expo_presentes', nueva, s.equipo.sofia)).estado, 'en_curso');
});

test('"¿Quién sos?": solo el equipo activo', async () => {
  const { db, s } = await base();
  await db.query(`update expo_equipo set activo = false where id = $1`, [s.equipo.ana]);
  const lista = await anon(db, 'expo_equipo_lista', CLAVE_EQUIPO);
  assert.deepEqual(lista.map((p) => p.nombre), ['Sofía Giménez']);
  await assert.rejects(anon(db, 'expo_presentes', CLAVE_EQUIPO, s.equipo.ana), /expo_equipo_invalido/);
});

test('el mismo nombre no se carga dos veces (tildes y mayúsculas no cuentan)', async () => {
  const { db } = await base();
  await assert.rejects(
    db.query(`insert into expo_equipo (nombre, rol) values ('sofia gimenez', 'hostess')`),
    /expo_equipo_nombre_unico/);
});

test('antes de la expo nadie se anota (aunque la clave ya ande para elegir el nombre)', async () => {
  const { db, s } = await base({ estado: 'previa' });
  assert.ok((await anon(db, 'expo_equipo_lista', CLAVE_EQUIPO)).length > 0);
  await db.query(`insert into expo_visitas (invitado_id, dia, cantidad) values ($1, expo_hoy(), 2)`, [s.papeltec.id]);
  const visita = await uno(db, `select id from expo_visitas`);
  await assert.rejects(anon(db, 'expo_anotarme', CLAVE_EQUIPO, s.equipo.sofia, visita), /expo_no_es_dia_de_expo/);
  assert.deepEqual((await anon(db, 'expo_presentes', CLAVE_EQUIPO, s.equipo.sofia)).presentes, []);
});

test('con la clave de otra edición no se baja a nadie', async () => {
  const { db, s } = await base();
  await anon(db, 'expo_registrar_visita', s.papeltec.token, 2);
  const visita = await uno(db, `select id from expo_visitas`);
  await anon(db, 'expo_anotarme', CLAVE_EQUIPO, s.equipo.sofia, visita);
  await db.query(`update expo_ediciones set estado = 'cerrada'`);
  await db.query(`insert into expo_ediciones (anio, dias, estado, clave_equipo_hash)
    values (2027, array[expo_hoy()], 'en_curso', encode(sha256(convert_to('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'UTF8')), 'hex'))`);
  await anon(db, 'expo_bajarme', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', s.equipo.sofia, visita);
  assert.equal(await uno(db, `select count(*)::int from expo_recorridos`), 1);
});

test('no se anota en una visita de otra edición', async () => {
  const { db, s } = await base();
  await db.query(`update expo_ediciones set estado = 'cerrada'`);
  const otra = await uno(db, `insert into expo_ediciones (anio, dias, estado, clave_equipo_hash)
    values (2027, array[expo_hoy()], 'en_curso', encode(sha256(convert_to('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'UTF8')), 'hex'))
    returning id`);
  assert.ok(otra);
  await db.query(`insert into expo_visitas (invitado_id, dia, cantidad) values ($1, expo_hoy(), 2)`, [s.papeltec.id]);
  const visita2026 = await uno(db, `select id from expo_visitas`);
  await assert.rejects(
    anon(db, 'expo_anotarme', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', s.equipo.sofia, visita2026),
    /expo_visita_invalida/);
});
