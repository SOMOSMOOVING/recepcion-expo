// Recepción vincula un alta sin código a un cliente de Finnegans.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base, anon, admin, uno, ADMIN, CLAVE_EQUIPO, CLAVE_CARTEL } from './db.mjs';

// Un alta de la puerta con su visita de hoy (como la crea el cartel).
async function altaConVisita(db) {
  const r = await anon(db, 'expo_alta_rapida', CLAVE_CARTEL, 'Silvina Fernández', 'Librería Papeltec', 'cliente', null, 4, null);
  const id = await uno(db, `select id from expo_invitados where token = $1`, [r.token]);
  return { id, token: r.token };
}

const visitas = (db, invitado) =>
  db.query(`select id, dia::text, cantidad, llegada from expo_visitas where invitado_id = $1 order by dia`, [invitado])
    .then((r) => r.rows);

test('vincular une las visitas del mismo día: cantidad mayor, llegada más temprana, todos los recorridos', async () => {
  const { db, s } = await base();
  // el cliente se registró con su QR (2 personas) y otro de la misma empresa
  // se registró en el cartel como alta (4 personas), un rato antes
  await anon(db, 'expo_registrar_visita', s.papeltec.token, 2);
  const a = await altaConVisita(db);
  await db.query(`update expo_visitas set llegada = llegada - interval '30 minutes' where invitado_id = $1`, [a.id]);
  const [vCliente] = await visitas(db, s.papeltec.id);
  const [vAlta] = await visitas(db, a.id);
  await db.query(`insert into expo_recorridos (visita_id, equipo_id) values ($1, $2), ($3, $4), ($3, $2)`,
    [vCliente.id, s.equipo.sofia, vAlta.id, s.equipo.ana]);

  const destino = await admin(db, 'expo_vincular', a.id, '10234');
  assert.equal(destino, s.papeltec.id);

  const [v, ...sobran] = await visitas(db, s.papeltec.id);
  assert.equal(sobran.length, 0, 'quedaron dos visitas el mismo día');
  assert.equal(v.cantidad, 4, 'no se quedó con la cantidad mayor');
  assert.equal(new Date(v.llegada).getTime(), new Date(vAlta.llegada).getTime(), 'no se quedó con la llegada más temprana');
  assert.equal((await visitas(db, a.id)).length, 0);

  const equipo = (await db.query(`select equipo_id from expo_recorridos where visita_id = $1 order by 1`, [v.id]))
    .rows.map((r) => r.equipo_id);
  assert.deepEqual(equipo, [s.equipo.sofia, s.equipo.ana].sort());
});

test('vincular: si el cliente vino con más gente y antes, se queda con lo suyo', async () => {
  // el caso cruzado del anterior: así no alcanza con tomar siempre lo del alta
  const { db, s } = await base();
  await anon(db, 'expo_registrar_visita', s.papeltec.token, 6);
  await db.query(`update expo_visitas set llegada = llegada - interval '1 hour' where invitado_id = $1`, [s.papeltec.id]);
  const [antes] = await visitas(db, s.papeltec.id);
  const a = await altaConVisita(db);  // 4 personas, ahora
  await admin(db, 'expo_vincular', a.id, '10234');
  const [v] = await visitas(db, s.papeltec.id);
  assert.equal(v.cantidad, 6);
  assert.equal(new Date(v.llegada).getTime(), new Date(antes.llegada).getTime());
});

test('un "Me anoto" que quedó en la cola con la visita del alta llega a la visita unida', async () => {
  const { db, s } = await base();
  await anon(db, 'expo_registrar_visita', s.papeltec.token, 2);
  const a = await altaConVisita(db);
  const [vAlta] = await visitas(db, a.id);
  await admin(db, 'expo_vincular', a.id, '10234');
  await anon(db, 'expo_anotarme', CLAVE_EQUIPO, s.equipo.sofia, vAlta.id);
  const [v] = await visitas(db, s.papeltec.id);
  assert.equal(await uno(db, `select count(*)::int from expo_recorridos where visita_id = $1`, [v.id]), 1);
  await anon(db, 'expo_bajarme', CLAVE_EQUIPO, s.equipo.sofia, vAlta.id);
  assert.equal(await uno(db, `select count(*)::int from expo_recorridos`), 0);
});

test('vincular conserva quién tomó el pedido aunque estuviera anotado en las dos visitas', async () => {
  const { db, s } = await base();
  await anon(db, 'expo_registrar_visita', s.papeltec.token, 2);
  const a = await altaConVisita(db);
  const [vCliente] = await visitas(db, s.papeltec.id);
  const [vAlta] = await visitas(db, a.id);
  // Sofía estaba en las dos; tomó el pedido en la del alta
  await anon(db, 'expo_anotarme', CLAVE_EQUIPO, s.equipo.sofia, vCliente.id);
  await anon(db, 'expo_anotarme', CLAVE_EQUIPO, s.equipo.sofia, vAlta.id);
  await anon(db, 'expo_tome_pedido', CLAVE_EQUIPO, s.equipo.sofia, vAlta.id, true);
  await admin(db, 'expo_vincular', a.id, '10234');
  assert.equal(await uno(db, `select tomo_pedido from expo_recorridos where visita_id = $1 and equipo_id = $2`,
    [vCliente.id, s.equipo.sofia]), true);
});

test('vincular deja quién vinculó y cuándo', async () => {
  const { db, s } = await base();
  const a = await altaConVisita(db);
  await admin(db, 'expo_vincular', a.id, '10234');
  const f = (await db.query(`select * from expo_invitados where id = $1`, [a.id])).rows[0];
  assert.equal(f.estado_vinculo, 'vinculada');
  assert.equal(f.vinculado_a, s.papeltec.id);
  assert.equal(f.vinculado_por, ADMIN.email);
  assert.ok(f.vinculado_en instanceof Date);
});

test('si el cliente no vino ese día, la visita del alta pasa a ser suya', async () => {
  const { db, s } = await base();
  const a = await altaConVisita(db);
  await admin(db, 'expo_vincular', a.id, '12577');
  const vs = await visitas(db, s.trebol.id);
  assert.equal(vs.length, 1);
  assert.equal(vs[0].cantidad, 4);
});

test('el link del alta, ya vinculada, muestra al cliente y no duplica la visita', async () => {
  const { db, s } = await base();
  const a = await altaConVisita(db);
  await admin(db, 'expo_vincular', a.id, '10234');
  const ver = await anon(db, 'expo_ver_invitado', a.token);
  assert.equal(ver.invitado.codigo_erp, '10234');
  assert.equal(ver.visita_hoy.cantidad, 4);
  assert.equal((await anon(db, 'expo_registrar_visita', a.token, 2)).nueva, false);
  assert.equal((await visitas(db, s.papeltec.id)).length, 1);
});

test('vincular a un cliente activo que no estaba invitado: toma sus datos de Finnegans', async () => {
  const { db } = await base();
  const a = await altaConVisita(db);
  assert.equal(await admin(db, 'expo_vincular', a.id, '15877'), a.id);
  const f = (await db.query(`select * from expo_invitados where id = $1`, [a.id])).rows[0];
  assert.equal(f.codigo_erp, '15877');
  assert.equal(f.razon_social, 'FERNANDEZ SILVINA - MARROQUINERIA KALU');
  assert.equal(f.vendedor, 'Laura Benítez');
  assert.equal(f.zona, 'CABA');
  assert.equal(f.localidad, 'Caballito');
  assert.equal(f.alta_empresa, 'Librería Papeltec', 'se perdió lo que escribió la persona');
  assert.equal(f.estado_vinculo, 'vinculada');
});

test('un código que no está en Finnegans no se vincula', async () => {
  const { db } = await base();
  const a = await altaConVisita(db);
  await assert.rejects(admin(db, 'expo_vincular', a.id, '99999'), /expo_codigo_desconocido/);
  assert.equal(await uno(db, `select estado_vinculo from expo_invitados where id = $1`, [a.id]), 'pendiente');
});

test('un alta ya vinculada no se vuelve a vincular; un invitado de la lista no es un alta', async () => {
  const { db, s } = await base();
  const a = await altaConVisita(db);
  await admin(db, 'expo_vincular', a.id, '10234');
  await assert.rejects(admin(db, 'expo_vincular', a.id, '12577'), /expo_alta_no_disponible/);
  await assert.rejects(admin(db, 'expo_vincular', s.trebol.id, '10234'), /expo_alta_no_disponible/);
});

test('"Es cliente nuevo" y "No es cliente"', async () => {
  const { db } = await base();
  const a = await altaConVisita(db);
  await admin(db, 'expo_marcar_alta', a.id, 'cliente_nuevo');
  assert.equal(await uno(db, `select estado_vinculo from expo_invitados where id = $1`, [a.id]), 'cliente_nuevo');
  await admin(db, 'expo_marcar_alta', a.id, 'no_cliente');
  assert.equal(await uno(db, `select estado_vinculo from expo_invitados where id = $1`, [a.id]), 'no_cliente');
  await assert.rejects(admin(db, 'expo_marcar_alta', a.id, 'vinculada'), /expo_estado_invalido/);
});

test('un alta ya vinculada no se puede marcar como no cliente', async () => {
  const { db } = await base();
  const a = await altaConVisita(db);
  await admin(db, 'expo_vincular', a.id, '10234');
  await assert.rejects(admin(db, 'expo_marcar_alta', a.id, 'no_cliente'), /expo_alta_no_disponible/);
  assert.equal(await uno(db, `select estado_vinculo from expo_invitados where id = $1`, [a.id]), 'vinculada');
});

test('sin alta ni código no hay invitado: la base exige código a los de la lista', async () => {
  const { db, s } = await base();
  await assert.rejects(
    db.query(`insert into expo_invitados (edicion_id, razon_social) values ($1, 'SIN CODIGO SA')`, [s.edicion]),
    /expo_invitados_codigo_obligatorio/);
  await assert.rejects(
    db.query(`insert into expo_invitados (edicion_id, codigo_erp, razon_social) values ($1, '10234', 'OTRO')`, [s.edicion]),
    /expo_invitados_codigo_unico/);
});
