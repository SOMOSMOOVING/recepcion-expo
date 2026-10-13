// Recepción en vivo (v02): el tablero del día y "¿Quién es en Finnegans?".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base, como, anon, admin, uno, ADMIN, VENDEDOR, CLAVE_CARTEL } from './db.mjs';

const alta = (db, nombre, empresa, categoria, cuit, cantidad) =>
  anon(db, 'expo_alta_rapida', CLAVE_CARTEL, nombre, empresa, categoria, cuit, cantidad, null);
const idDe = (db, token) => uno(db, `select id from expo_invitados where token = $1`, [token]);
const buscarCliente = (db, texto, cuit = null) => como(db, 'authenticated', ADMIN,
  async (tx) => (await tx.query(`select * from public.expo_buscar_cliente($1, $2)`, [texto, cuit])).rows);

/* Un día de expo armado a mano:
   · turnos de hoy: Papeltec 10–11 (llegó, 2 personas), El Trébol 9–10 y Luján 11–12 (no llegaron)
   · turnos de otros días, que hoy no cuentan: Papeltec ayer, un invitado mañana y
     el cliente "sin turno" ayer (hoy vino sin turno)
   · un cliente sin turno hoy (4 personas), un alta "soy cliente" sin código (Kalu, 2) y
     un alta de un proveedor (3: no cliente)
   · ayer: El Trébol, 5 personas */
async function diaDeExpo() {
  const { db, s } = await base();
  await db.query(`insert into expo_turnos (invitado_id, dia, desde, hasta) values
                    ($1, expo_hoy(), '09:00', '10:00'), ($2, expo_hoy(), '11:00', '12:00')`, [s.trebol.id, s.lujan.id]);
  await anon(db, 'expo_registrar_visita', s.papeltec.token, 2);
  const sinTurno = await uno(db, `insert into expo_invitados (edicion_id, codigo_erp, razon_social, zona, localidad, vendedor)
                                  values ($1, '20001', 'LIBRERIA SIN TURNO', 'CABA', 'Flores', 'Laura Benítez') returning token`, [s.edicion]);
  await anon(db, 'expo_registrar_visita', sinTurno, 4);
  const manana = await uno(db, `insert into expo_invitados (edicion_id, codigo_erp, razon_social)
                                values ($1, '20002', 'LIBRERIA DE MAÑANA') returning id`, [s.edicion]);
  await db.query(`insert into expo_turnos (invitado_id, dia, desde, hasta) values
                    ($1, expo_hoy() - 1, '09:00', '10:00'), ($2, expo_hoy() + 1, '09:00', '10:00'),
                    ($3, expo_hoy() - 1, '12:00', '13:00')`, [s.papeltec.id, manana, await idDe(db, sinTurno)]);
  const kalu = await alta(db, 'Silvina Fernández', 'Marroquinería Kalu', 'cliente', '27-28455120-3', 2);
  await alta(db, 'Pedro Gómez', 'Papelera del Sur', 'proveedor', null, 3);
  await db.query(`insert into expo_visitas (invitado_id, dia, llegada, cantidad)
                  values ($1, expo_hoy() - 1, now() - interval '1 day', 5)`, [s.trebol.id]);
  return { db, s, kalu: { ...kalu, id: await idDe(db, kalu.token) } };
}

test('recepción: solo un admin (el anónimo ni la ve; un logueado que no es admin, tampoco)', async () => {
  const { db } = await base();
  for (const fn of ['expo_recepcion()', `expo_buscar_cliente('kalu', null)`]) {
    await assert.rejects(como(db, 'anon', {}, (tx) => tx.query(`select public.${fn}`)), /permission denied/, fn);
    await assert.rejects(como(db, 'authenticated', VENDEDOR, (tx) => tx.query(`select public.${fn}`)), /expo_solo_admin/, fn);
  }
});

test('recepción: cifras de hoy (los no clientes van aparte) y quién tenía turno y no llegó', async () => {
  const { db, s, kalu } = await diaDeExpo();
  const r = await admin(db, 'expo_recepcion');
  assert.equal(r.estado, 'en_curso');
  assert.equal(r.es_dia, true);
  assert.equal(r.hoy, await uno(db, `select expo_hoy()::text`));
  // Papeltec, el sin turno y Kalu (dijo ser cliente): 3 clientes, 8 personas, 2 sin turno hoy
  assert.deepEqual(r.cifras, { clientes: 3, personas: 8, sin_turno: 2, no_clientes: 1, no_clientes_personas: 3 });
  assert.equal(r.con_turno, 3);
  assert.deepEqual(r.faltantes.map((f) => [f.razon_social, f.desde, f.hasta]), [
    ['GONZALEZ HNOS S.A. - JUGUETERIA EL TREBOL', '09:00:00', '10:00:00'],
    ['COOPERATIVA ESCOLAR NUESTRA SEÑORA DE LUJAN LTDA', '11:00:00', '12:00:00'],
  ]);
  assert.deepEqual(Object.keys(r.faltantes[0]).sort(), ['desde', 'hasta', 'invitado_id', 'localidad', 'razon_social', 'vendedor', 'zona']);
  assert.equal(JSON.stringify(r.faltantes).includes('MAÑANA'), false, 'un turno de mañana figura como faltante de hoy');
  assert.equal(r.faltantes[0].vendedor, 'Diego Acosta');
  assert.deepEqual(r.no_clientes, [{ categoria: 'proveedor', cantidad: 1, personas: 3 }]);
  assert.deepEqual(r.ayer, { dia: await uno(db, `select (expo_hoy() - 1)::text`), clientes: 1, personas: 5 });

  // el alta del proveedor no espera vínculo (ya es "no cliente"); la de Kalu sí
  assert.equal(r.altas.length, 1);
  const [a] = r.altas;
  assert.equal(a.id, kalu.id);
  assert.equal(a.empresa, 'Marroquinería Kalu');
  assert.equal(a.nombre, 'Silvina Fernández');
  assert.equal(a.categoria, 'cliente');
  assert.equal(a.cuit, '27-28455120-3');
  assert.equal(a.cantidad, 2);
  assert.ok(a.llegada && a.dia);
  assert.deepEqual(Object.keys(a).sort(), ['cantidad', 'categoria', 'cuit', 'dia', 'empresa', 'id', 'llegada', 'nombre']);
  // ni los tokens de los QR (de los que aparecen: faltantes y altas)
  for (const token of [kalu.token, s.trebol.token, s.lujan.token]) {
    assert.equal(JSON.stringify(r).includes(token), false, 'devuelve tokens de los QR');
  }
});

test('recepción: "Es cliente nuevo" cuenta como cliente aunque haya dicho que venía con uno; "No es cliente", al revés', async () => {
  const { db } = await diaDeExpo();
  const conCliente = await alta(db, 'Ana', 'Bazar Ana', 'cliente_de_cliente', null, 3);
  let r = await admin(db, 'expo_recepcion');
  assert.equal(r.cifras.clientes, 3);
  assert.equal(r.altas.length, 2, 'quien vino con un cliente también espera vínculo');
  await admin(db, 'expo_marcar_alta', await idDe(db, conCliente.token), 'cliente_nuevo');
  r = await admin(db, 'expo_recepcion');
  assert.deepEqual([r.cifras.clientes, r.cifras.personas], [4, 11]);
  assert.deepEqual(r.no_clientes, [{ categoria: 'proveedor', cantidad: 1, personas: 3 }]);

  const otraConCliente = await alta(db, 'Juan', 'Bazar Juan', 'cliente_de_cliente', null, 2);
  await admin(db, 'expo_marcar_alta', await idDe(db, otraConCliente.token), 'no_cliente');
  r = await admin(db, 'expo_recepcion');
  assert.deepEqual(r.no_clientes.map((n) => n.categoria).sort(), ['no_cliente', 'proveedor']);
});

test('recepción: al vincular un alta sale de la lista; si es "no cliente", pasa a los no clientes', async () => {
  const { db, kalu } = await diaDeExpo();
  await admin(db, 'expo_vincular', kalu.id, '15877');
  let r = await admin(db, 'expo_recepcion');
  assert.deepEqual(r.altas, []);
  assert.equal(r.cifras.clientes, 3, 'Kalu vinculada sigue siendo cliente');

  const otra = await alta(db, 'Juan', 'Bazar Juan', 'cliente', null, 4);
  await admin(db, 'expo_marcar_alta', await idDe(db, otra.token), 'no_cliente');
  r = await admin(db, 'expo_recepcion');
  assert.deepEqual(r.altas, []);
  assert.equal(r.cifras.clientes, 3, 'contó como cliente un alta marcada "no es cliente"');
  assert.deepEqual(r.no_clientes, [
    { categoria: 'no_cliente', cantidad: 1, personas: 4 },
    { categoria: 'proveedor', cantidad: 1, personas: 3 },
  ]);
});

test('recepción: antes del primer día no hay "ayer"; sin expo abierta lo dice', async () => {
  const { db } = await base();
  await db.query(`update expo_ediciones set dias = array[expo_hoy(), expo_hoy() + 1]`);
  const r = await admin(db, 'expo_recepcion');
  assert.equal(r.ayer, null);
  assert.deepEqual(r.cifras, { clientes: 0, personas: 0, sin_turno: 0, no_clientes: 0, no_clientes_personas: 0 });
  assert.equal(r.faltantes.length, 1, 'Papeltec tiene turno hoy');

  await db.query(`update expo_ediciones set estado = 'cerrada'`);
  assert.equal((await admin(db, 'expo_recepcion')).estado, 'sin_edicion');
});

test('¿Quién es en Finnegans?: por CUIT (con guiones o sin), por nombre o código, y de la lista de la expo', async () => {
  const { db } = await base();
  await db.query(`insert into expo_clientes (codigo_erp, razon_social, cuit, zona, localidad, vendedor) values
                    ('31220', 'KALU ACCESORIOS S.R.L.', '30712345679', 'Zona Oeste', 'Morón', 'Diego Acosta'),
                    ('99999', 'KALU CERRADA S.A.', null, null, null, null)`);
  await db.query(`update expo_clientes set activo = false where codigo_erp = '99999'`);

  // por nombre: los dos activos; el dado de baja no
  let r = await buscarCliente(db, 'kalu', '27-28455120-3');
  assert.deepEqual(r.map((f) => [f.codigo_erp, f.coincide_cuit]), [['15877', true], ['31220', false]]);
  assert.deepEqual(Object.keys(r[0]).sort(), ['codigo_erp', 'coincide_cuit', 'localidad', 'razon_social', 'vendedor', 'zona']);

  // por CUIT aunque el nombre no se parezca
  r = await buscarCliente(db, 'cualquier cosa', '27284551203');
  assert.deepEqual(r.map((f) => f.codigo_erp), ['15877']);

  // un invitado de la lista que todavía no está en la copia de Finnegans
  r = await buscarCliente(db, 'papeltec');
  assert.deepEqual(r.map((f) => f.codigo_erp), ['10234']);
  r = await buscarCliente(db, '12577');
  assert.deepEqual(r.map((f) => f.codigo_erp), ['12577']);

  // un CUIT escrito en la búsqueda (la persona no lo cargó en el cartel)
  for (const escrito of ['27284551203', '27-28455120-3']) {
    r = await buscarCliente(db, escrito, null);
    assert.deepEqual(r.map((f) => [f.codigo_erp, f.coincide_cuit]), [['15877', true]], escrito);
  }

  // muy corto y sin CUIT: nada (no lista todo)
  assert.deepEqual(await buscarCliente(db, 'k'), []);
  assert.deepEqual(await buscarCliente(db, '  ', '123'), []);
});

test('¿Quién es en Finnegans?: un invitado de la lista sale una vez, aunque en la copia figure con otro nombre o dado de baja; las altas nunca', async () => {
  const { db } = await base();
  // en la copia de Finnegans, Papeltec está con otro nombre; El Trébol, dado de baja
  await db.query(`insert into expo_clientes (codigo_erp, razon_social, cuit, activo) values
                    ('10234', 'MINUCHIN MARTA LILIANA', '27111111113', true),
                    ('12577', 'GONZALEZ HNOS S.A.', null, false)`);
  await alta(db, 'Silvina Fernández', 'Marroquinería Kalu', 'cliente', null, 2);

  assert.deepEqual((await buscarCliente(db, 'papeltec')).map((f) => [f.codigo_erp, f.razon_social]),
    [['10234', 'MINUCHIN MARTA LILIANA']], 'el invitado no aparece, o aparece dos veces');
  assert.deepEqual((await buscarCliente(db, '10234')).map((f) => f.codigo_erp), ['10234']);
  assert.deepEqual((await buscarCliente(db, 'trebol')).map((f) => f.codigo_erp), ['12577'], 'un invitado dado de baja en la copia desaparece');
  assert.deepEqual((await buscarCliente(db, 'x', '27-11111111-3')).map((f) => f.codigo_erp), ['10234']);
  // el alta de la puerta (sin código) no se ofrece como opción: solo Kalu de Finnegans
  assert.deepEqual((await buscarCliente(db, 'kalu')).map((f) => f.codigo_erp), ['15877']);
});

test('¿Quién es en Finnegans?: como mucho 8', async () => {
  const { db } = await base();
  await db.query(`insert into expo_clientes (codigo_erp, razon_social)
                  select 'L' || n, 'LIBRERIA NUMERO ' || n from generate_series(1, 20) n`);
  assert.equal((await buscarCliente(db, 'libreria numero')).length, 8);
});
