// Check-in del cliente: confirmar antes, registrar durante, corregir, sin señal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base, anon, uno } from './db.mjs';

const visitasDe = (db, id) =>
  db.query(`select dia::text, cantidad, sin_senal, llegada from expo_visitas where invitado_id = $1 order by dia`, [id])
    .then((r) => r.rows);

test('el mismo día no se registra dos veces: el segundo devuelve el primero', async () => {
  const { db, s } = await base();
  const a = await anon(db, 'expo_registrar_visita', s.papeltec.token, 2);
  assert.equal(a.nueva, true);
  const b = await anon(db, 'expo_registrar_visita', s.papeltec.token, 5);
  assert.equal(b.nueva, false);
  assert.equal(b.cantidad, 2, 'el segundo registro pisó la cantidad');
  assert.equal(b.llegada, a.llegada);
  assert.equal((await visitasDe(db, s.papeltec.id)).length, 1);
});

test('la base tampoco acepta dos visitas el mismo día (aunque las cargue recepción)', async () => {
  const { db, s } = await base();
  await db.query(`insert into expo_visitas (invitado_id, dia, cantidad) values ($1, expo_hoy(), 2)`, [s.papeltec.id]);
  await assert.rejects(
    db.query(`insert into expo_visitas (invitado_id, dia, cantidad) values ($1, expo_hoy(), 3)`, [s.papeltec.id]),
    /expo_visitas_una_por_dia/);
});

test('venir otro día crea otra visita y la pantalla lo avisa', async () => {
  const { db, s } = await base();
  await db.query(`insert into expo_visitas (invitado_id, dia, cantidad) values ($1, expo_hoy() - 1, 3)`, [s.papeltec.id]);
  const ver = await anon(db, 'expo_ver_invitado', s.papeltec.token);
  assert.equal(ver.visita_hoy, null);
  assert.equal(ver.visita_anterior.cantidad, 3);
  assert.equal(ver.visita_anterior.dia, await uno(db, `select (expo_hoy() - 1)::text`));
  await anon(db, 'expo_registrar_visita', s.papeltec.token, 2);
  assert.deepEqual((await visitasDe(db, s.papeltec.id)).map((v) => v.cantidad), [3, 2]);
});

test('recién registrado: devuelve hora, cantidad y credencial', async () => {
  const { db, s } = await base();
  const r = await anon(db, 'expo_registrar_visita', s.papeltec.token, 2);
  assert.equal(r.cantidad, 2);
  assert.equal(r.nombre_credencial, 'LIBRERÍA PAPELTEC');
  const ver = await anon(db, 'expo_ver_invitado', s.papeltec.token);
  assert.equal(ver.visita_hoy.cantidad, 2);
  assert.deepEqual(ver.turno_hoy, { desde: '10:00:00', hasta: '11:00:00' });
});

test('corregir la cantidad cambia la visita de hoy; sin visita no hay qué corregir', async () => {
  const { db, s } = await base();
  await assert.rejects(anon(db, 'expo_corregir_cantidad', s.papeltec.token, 4), /expo_sin_visita_hoy/);
  await anon(db, 'expo_registrar_visita', s.papeltec.token, 2);
  const r = await anon(db, 'expo_corregir_cantidad', s.papeltec.token, 4);
  assert.equal(r.cantidad, 4);
  assert.equal((await visitasDe(db, s.papeltec.id))[0].cantidad, 4);
});

test('la cantidad va de 1 a 30', async () => {
  const { db, s } = await base();
  for (const n of [0, -1, 31, null]) {
    await assert.rejects(anon(db, 'expo_registrar_visita', s.papeltec.token, n), /expo_cantidad_invalida/, String(n));
  }
  assert.equal((await anon(db, 'expo_registrar_visita', s.papeltec.token, 30)).cantidad, 30);
});

test('sin señal: el reintento guarda la hora del celular y no duplica', async () => {
  const { db, s } = await base();
  const hace = await uno(db, `select (now() - interval '20 minutes')::text`);
  const a = await anon(db, 'expo_registrar_visita', s.papeltec.token, 2, hace);
  assert.equal(a.nueva, true);
  const [v] = await visitasDe(db, s.papeltec.id);
  assert.equal(v.sin_senal, true);
  assert.equal(new Date(v.llegada).getTime(), new Date(hace).getTime(), 'no usó la hora del celular');
  // la cola vuelve a mandar lo mismo (se cortó la respuesta)
  const b = await anon(db, 'expo_registrar_visita', s.papeltec.token, 2, hace);
  assert.equal(b.nueva, false);
  assert.equal((await visitasDe(db, s.papeltec.id)).length, 1);
});

test('sin señal: una hora del celular que no es creíble se rechaza', async () => {
  const { db, s } = await base();
  const futuro = await uno(db, `select (now() + interval '2 hours')::text`);
  await assert.rejects(anon(db, 'expo_registrar_visita', s.papeltec.token, 2, futuro), /expo_no_es_dia_de_expo/);
  const viejo = await uno(db, `select (now() - interval '10 days')::text`);
  await assert.rejects(anon(db, 'expo_registrar_visita', s.papeltec.token, 2, viejo), /expo_no_es_dia_de_expo/);
  assert.equal((await visitasDe(db, s.papeltec.id)).length, 0);
});

test('sin señal: más de 3 días de demora se rechaza aunque ese día haya sido de expo', async () => {
  const { db, s } = await base();
  await db.query(`update expo_ediciones set dias = array[expo_hoy() - 4, expo_hoy()]`);
  const hace4 = await uno(db, `select (now() - interval '4 days')::text`);
  await assert.rejects(anon(db, 'expo_registrar_visita', s.papeltec.token, 2, hace4), /expo_no_es_dia_de_expo/);
});

test('sin señal: celular con el reloj adelantado media hora entra con la hora del servidor', async () => {
  const { db, s } = await base();
  const adelantado = await uno(db, `select (now() + interval '30 minutes')::text`);
  const r = await anon(db, 'expo_registrar_visita', s.papeltec.token, 2, adelantado);
  assert.ok(new Date(r.llegada) < new Date(adelantado), 'guardó una llegada en el futuro');
});

test('sin señal: el día se cuenta en hora argentina aunque la base esté en UTC', async () => {
  const { db, s } = await base();
  assert.equal(await uno(db, `show timezone`), 'UTC');
  // ayer a las 23:30 en Buenos Aires ya es hoy en UTC: tiene que contar como ayer
  const anoche = await uno(db, `
    select ((expo_hoy() - 1 + time '23:30') at time zone 'America/Argentina/Buenos_Aires')::text`);
  const r = await anon(db, 'expo_registrar_visita', s.papeltec.token, 2, anoche);
  assert.equal(r.dia, await uno(db, `select (expo_hoy() - 1)::text`));
});

test('sin señal: si recepción cerró la expo antes de que vuelva la señal, igual entra', async () => {
  const { db, s } = await base();
  const hace = await uno(db, `select (now() - interval '5 minutes')::text`);
  await db.query(`update expo_ediciones set estado = 'cerrada'`);
  assert.equal((await anon(db, 'expo_registrar_visita', s.papeltec.token, 2, hace)).nueva, true);
  // pero sin la hora del celular (registro en vivo) ya no
  await assert.rejects(anon(db, 'expo_registrar_visita', s.trebol.token, 2), /expo_no_es_dia_de_expo/);
});

test('no se registra asistencia antes de la expo', async () => {
  const { db, s } = await base({ estado: 'previa' });
  await assert.rejects(anon(db, 'expo_registrar_visita', s.papeltec.token, 2), /expo_no_es_dia_de_expo/);
  const hace = await uno(db, `select (now() - interval '5 minutes')::text`);
  await assert.rejects(anon(db, 'expo_registrar_visita', s.papeltec.token, 2, hace), /expo_no_es_dia_de_expo/);
});

test('en curso pero hoy no es día de expo: no registra', async () => {
  const { db, s } = await base();
  await db.query(`update expo_ediciones set dias = array[expo_hoy() + 1, expo_hoy() + 2]`);
  await assert.rejects(anon(db, 'expo_registrar_visita', s.papeltec.token, 2), /expo_no_es_dia_de_expo/);
});

test('antes de la expo: confirmar, cambiar la cantidad y avisar que no van', async () => {
  const { db, s } = await base({ estado: 'previa' });
  let r = await anon(db, 'expo_ver_invitado', s.papeltec.token);
  assert.equal(r.estado, 'previa');
  assert.equal(r.confirmado, null);
  assert.equal(r.turno.desde, '10:00:00');

  r = await anon(db, 'expo_confirmar', s.papeltec.token, 2, true);
  assert.equal(r.confirmado, true);
  assert.equal(r.confirmado_cantidad, 2);

  r = await anon(db, 'expo_confirmar', s.papeltec.token, 3, true);
  assert.equal(r.confirmado_cantidad, 3);

  r = await anon(db, 'expo_confirmar', s.papeltec.token, null, false);
  assert.equal(r.confirmado, false);
  assert.equal(r.confirmado_cantidad, null);
});

test('confirmar que van exige la cantidad', async () => {
  const { db, s } = await base({ estado: 'previa' });
  await assert.rejects(anon(db, 'expo_confirmar', s.papeltec.token, null, true), /expo_cantidad_invalida/);
  await assert.rejects(anon(db, 'expo_confirmar', s.papeltec.token, 31, true), /expo_cantidad_invalida/);
  await assert.rejects(anon(db, 'expo_confirmar', s.papeltec.token, 2, null), /expo_falta_respuesta/);
  assert.equal(await uno(db, `select confirmado from expo_invitados where id = $1`, [s.papeltec.id]), null);
});

test('con la expo cerrada ya no se corrige la cantidad', async () => {
  const { db, s } = await base();
  await anon(db, 'expo_registrar_visita', s.papeltec.token, 2);
  await db.query(`update expo_ediciones set estado = 'cerrada'`);
  await assert.rejects(anon(db, 'expo_corregir_cantidad', s.papeltec.token, 5), /expo_no_es_dia_de_expo/);
});

test('durante la expo ya no se confirma', async () => {
  const { db, s } = await base();
  await assert.rejects(anon(db, 'expo_confirmar', s.papeltec.token, 2, true), /expo_no_es_previa/);
});

test('expo terminada: el link sigue vivo y dice el vendedor', async () => {
  const { db, s } = await base({ estado: 'cerrada' });
  const r = await anon(db, 'expo_ver_invitado', s.papeltec.token);
  assert.equal(r.estado, 'cerrada');
  assert.equal(r.vendedor, 'Juan Pérez');
  assert.equal(r.invitado.razon_social, 'MINUCHIN MARTA LILIANA - LIBRERIA PAPELTEC');
});

test('el link de una expo vieja es un QR inválido', async () => {
  const { db, s } = await base({ estado: 'cerrada' });
  await db.query(`insert into expo_ediciones (anio, dias) values (2027, array[expo_hoy() + 300])`);
  assert.deepEqual(await anon(db, 'expo_ver_invitado', s.papeltec.token), { estado: 'invalido' });
  await assert.rejects(anon(db, 'expo_registrar_visita', s.papeltec.token, 2), /expo_no_es_dia_de_expo/);
});

test('turnos y visitas solo en días de la expo', async () => {
  const { db, s } = await base();
  await assert.rejects(
    db.query(`insert into expo_turnos (invitado_id, dia, desde, hasta) values ($1, expo_hoy() + 9, '10:00', '11:00')`, [s.trebol.id]),
    /expo_dia_fuera_de_la_expo/);
  await assert.rejects(
    db.query(`insert into expo_visitas (invitado_id, dia, cantidad) values ($1, expo_hoy() - 9, 2)`, [s.trebol.id]),
    /expo_dia_fuera_de_la_expo/);
});

test('una sola expo abierta a la vez', async () => {
  const { db } = await base({ estado: 'previa' });
  await assert.rejects(
    db.query(`insert into expo_ediciones (anio, dias) values (2027, array[expo_hoy() + 300])`),
    /expo_ediciones_una_abierta/);
});
