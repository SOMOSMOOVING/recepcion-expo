// Cartel de la entrada: buscador y alta rápida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base, uno, rpc, como, admin, CLAVE_CARTEL } from './db.mjs';

// expo_buscar devuelve filas (no un valor): se llama como anónimo.
const buscar = (db, texto, clave = CLAVE_CARTEL) =>
  como(db, 'anon', {}, async (tx) =>
    (await tx.query(`select * from public.expo_buscar($1, $2)`, [clave, texto])).rows);

const alta = (db, { nombre = 'Silvina Fernández', empresa = 'Marroquinería Kalu', categoria = 'cliente',
                    cuit = null, cantidad = 2, clave = null, cartel = CLAVE_CARTEL } = {}) =>
  rpc(db, 'anon', {}, 'expo_alta_rapida', [cartel, nombre, empresa, categoria, cuit, cantidad, clave]);

test('sin la clave del QR del cartel no se busca ni se da de alta', async () => {
  const { db } = await base();
  for (const c of ['', 'x', 'f'.repeat(32), null, CLAVE_CARTEL.toUpperCase()]) {
    await assert.rejects(buscar(db, 'papel', c), /expo_clave_cartel_invalida/, String(c));
    await assert.rejects(alta(db, { cartel: c }), /expo_clave_cartel_invalida/, String(c));
  }
  assert.equal(await uno(db, `select count(*)::int from expo_invitados where origen = 'alta_puerta'`), 0);
});

test('la clave del equipo no sirve como clave del cartel', async () => {
  const { db } = await base();
  await assert.rejects(buscar(db, 'papel', '0123456789abcdef0123456789abcdef'), /expo_clave_cartel_invalida/);
});

test('cuando la expo cierra, la clave del cartel deja de andar', async () => {
  const { db } = await base();
  await db.query(`update expo_ediciones set estado = 'cerrada'`);
  await assert.rejects(buscar(db, 'papel'), /expo_clave_cartel_invalida/);
});

test('recepción cambia la clave del cartel: la vieja deja de andar', async () => {
  const { db } = await base();
  const nueva = await admin(db, 'expo_nueva_clave_cartel');
  await assert.rejects(buscar(db, 'papel'), /expo_clave_cartel_invalida/);
  assert.equal((await buscar(db, 'papel', nueva)).length, 1);
});

test('busca sin tildes ni mayúsculas en razón social, fantasía y código', async () => {
  const { db, s } = await base();
  await db.query(`update expo_invitados set nombre_fantasia = 'El Trébol' where id = $1`, [s.trebol.id]);
  const razones = async (q) => (await buscar(db, q)).map((r) => r.codigo_erp);
  assert.deepEqual(await razones('papel'), ['10234']);
  assert.deepEqual(await razones('PAPELTEC'), ['10234']);
  assert.deepEqual(await razones('Señora Luján'), ['14420']);
  assert.deepEqual(await razones('senora lujan'), ['14420']);
  assert.deepEqual(await razones('trébol'), ['12577']);
  assert.deepEqual(await razones('10234'), ['10234']);
  assert.deepEqual(await razones('hnos sa'), ['12577'], 'S.A. no se encuentra como "sa"');
});

test('con menos de 3 letras no busca', async () => {
  const { db } = await base();
  assert.equal((await buscar(db, 'pa')).length, 0);
  assert.equal((await buscar(db, ' p a ')).length, 0);
  assert.equal((await buscar(db, '')).length, 0);
  assert.ok((await buscar(db, 'pap')).length > 0);
});

test('devuelve como máximo 8', async () => {
  const { db, s } = await base();
  for (let n = 1; n <= 12; n++) {
    await db.query(`insert into expo_invitados (edicion_id, codigo_erp, razon_social) values ($1, $2, $3)`,
      [s.edicion, String(50000 + n), `LIBRERIA ESCOLAR NUMERO ${n}`]);
  }
  assert.equal((await buscar(db, 'escolar')).length, 8);
});

test('comodines de SQL no traen la lista entera', async () => {
  const { db } = await base();
  for (const q of ['%%%', '___', "' or ''='", '.*.*.*']) {
    assert.equal((await buscar(db, q)).length, 0, q);
  }
});

test('no muestra las altas de la puerta ni busca fuera de la expo', async () => {
  const { db } = await base();
  await alta(db, { empresa: 'Papelera Kalu' });
  assert.deepEqual((await buscar(db, 'kalu')), []);
  await db.query(`update expo_ediciones set estado = 'previa'`);
  assert.deepEqual((await buscar(db, 'papel')), []);
});

test('alta rápida: crea el invitado de la puerta y la visita de hoy', async () => {
  const { db } = await base();
  const r = await alta(db, { nombre: '  Silvina   Fernández ', empresa: 'Marroquinería  Kalu', cuit: '27-28455120-3' });
  assert.equal(r.nueva, true);
  assert.equal(r.razon_social, 'Marroquinería Kalu');
  assert.equal(r.cantidad, 2);
  const f = (await db.query(`select * from expo_invitados where token = $1`, [r.token])).rows[0];
  assert.equal(f.origen, 'alta_puerta');
  assert.equal(f.codigo_erp, null);
  assert.equal(f.estado_vinculo, 'pendiente');
  assert.equal(f.alta_nombre, 'Silvina Fernández');
  assert.equal(f.alta_cuit, '27-28455120-3');
  assert.equal(await uno(db, `select count(*)::int from expo_visitas where invitado_id = $1 and dia = expo_hoy()`, [f.id]), 1);
});

test('alta rápida: proveedor, comex y licencias quedan como no clientes', async () => {
  const { db } = await base();
  const estado = async (categoria) => uno(db,
    `select estado_vinculo from expo_invitados where token = $1`,
    [(await alta(db, { categoria, empresa: `Empresa ${categoria}` })).token]);
  assert.equal(await estado('cliente'), 'pendiente');
  assert.equal(await estado('cliente_de_cliente'), 'pendiente');
  assert.equal(await estado('proveedor'), 'no_cliente');
  assert.equal(await estado('comex'), 'no_cliente');
  assert.equal(await estado('licencia'), 'no_cliente');
});

test('alta rápida: largos y categoría controlados', async () => {
  const { db } = await base();
  await assert.rejects(alta(db, { nombre: ' ' }), /expo_nombre_invalido/);
  await assert.rejects(alta(db, { nombre: null }), /expo_nombre_invalido/);
  await assert.rejects(alta(db, { nombre: 'x'.repeat(81) }), /expo_nombre_invalido/);
  await assert.rejects(alta(db, { empresa: 'x'.repeat(121) }), /expo_empresa_invalida/);
  await assert.rejects(alta(db, { categoria: 'vendedor' }), /expo_categoria_invalida/);
  await assert.rejects(alta(db, { cuit: '<script>' }), /expo_cuit_invalido/);
  await assert.rejects(alta(db, { cantidad: 0 }), /expo_cantidad_invalida/);
});

test('alta rápida: el reintento con la misma clave no duplica', async () => {
  const { db } = await base();
  const clave = '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
  const a = await alta(db, { clave });
  const b = await alta(db, { clave });
  assert.equal(b.nueva, false);
  assert.equal(b.token, a.token);
  assert.equal(await uno(db, `select count(*)::int from expo_invitados where origen = 'alta_puerta'`), 1);
});

test('alta rápida: frena después de 12 por minuto', async () => {
  const { db } = await base();
  for (let n = 1; n <= 12; n++) await alta(db, { empresa: `Comercio ${n}` });
  await assert.rejects(alta(db, { empresa: 'Comercio 13' }), /expo_demasiadas_altas_minuto/);
  // pasado el minuto, vuelve a andar
  await db.query(`update expo_invitados set creado_en = creado_en - interval '2 minutes' where origen = 'alta_puerta'`);
  assert.equal((await alta(db, { empresa: 'Comercio 13' })).nueva, true);
});

test('alta rápida: tope de 300 por día', async () => {
  const { db, s } = await base();
  await db.query(`
    insert into expo_invitados (edicion_id, razon_social, origen, estado_vinculo, creado_en)
    -- al principio del día argentino: mismo día y fuera del freno por minuto
    select $1, 'Comercio ' || n, 'alta_puerta', 'pendiente',
           expo_hoy()::timestamp at time zone 'America/Argentina/Buenos_Aires'
      from generate_series(1, 300) n`, [s.edicion]);
  await assert.rejects(alta(db), /expo_demasiadas_altas_dia/);
});

test('alta rápida: el reintento después de que recepción la vinculó trae la visita del cliente', async () => {
  const { db } = await base();
  const clave = '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
  const a = await alta(db, { clave, cantidad: 3 });
  const id = await uno(db, `select id from expo_invitados where token = $1`, [a.token]);
  await admin(db, 'expo_vincular', id, '12577');
  const b = await alta(db, { clave, cantidad: 3 });
  assert.equal(b.nueva, false);
  assert.equal(b.cantidad, 3);
});

test('alta rápida: solo en un día de expo en curso', async () => {
  const { db } = await base({ estado: 'previa' });
  await assert.rejects(alta(db), /expo_no_es_dia_de_expo/);
});
