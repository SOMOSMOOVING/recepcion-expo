// Pantalla 3 · equipo de recorrido (#equipo=CLAVE → #recorrido).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrir, cola, vuelveLaSenal, respuestaDe, visitaDePrueba as visita, SIN_RED, hoy, dia } from './navegador.mjs';

const ANCHO = 390;   // el ancho de estos tests; los demás anchos están en anchos.test.mjs
const CLAVE = '0123456789abcdef0123456789abcdef';
const SOFIA = { id: '11111111-1111-4111-8111-111111111111', nombre: 'Sofía Giménez', rol: 'hostess' };
const ANA = { id: '22222222-2222-4222-8222-222222222222', nombre: 'Ana López', rol: 'marketing' };
const CAMILA = { id: '33333333-3333-4333-8333-333333333333', nombre: 'Camila Rodríguez', rol: 'hostess' };
const EQUIPO = [ANA, CAMILA, { id: '44444444-4444-4444-8444-444444444444', nombre: 'Soledad Ríos', rol: 'marketing' }, SOFIA];

const TREBOL = visita(1, 'GONZALEZ HNOS S.A. - JUGUETERIA EL TREBOL', { cantidad: 3, zona: 'Zona Oeste', vendedor: 'Diego Acosta' });
const KALU = visita(2, 'FERNANDEZ SILVINA - MARROQUINERIA KALU', { sin_codigo: true, vendedor: null, zona: 'CABA' });
const PAPELTEC = visita(3, 'MINUCHIN MARTA LILIANA - LIBRERIA PAPELTEC', { recorrido: [{ id: ANA.id, nombre: ANA.nombre, tomo_pedido: false }, { id: CAMILA.id, nombre: CAMILA.nombre, tomo_pedido: true }] });
const COMEX = visita(4, 'TRANSANDINA LOGISTICA INTERNACIONAL S.A.', { categoria: 'comex', vendedor: null, zona: 'Interior', cantidad: 1 });

const presentes = (lista) => ({ estado: 'en_curso', hoy: hoy(), es_dia: true, hora_apertura: '09:00:00', presentes: lista });
const comoSofia = { expoEquipo: CLAVE, expoYo: SOFIA };
const texto = (page) => page.textContent('#app');
const tarjetas = (page) => page.$$eval('.mr-presente', (ts) => ts.map((t) => ({
  razon: t.querySelector('.mr-presente-razon').textContent,
  atiende: t.querySelector('.mr-atiende').textContent,
  boton: t.querySelector('.mr-presente-pie .mr-boton').textContent,
  mio: t.classList.contains('mr-presente--mio'),
})));
const fnsEnCola = async (page) => (await cola(page)).map((i) => i.fn);
const colaVacia = (page) => page.waitForFunction(() => JSON.parse(localStorage.getItem('expoCola') || '[]').length === 0);
const cerrar = (page) => page.context().close();

/* Simula la base: guarda los recorridos y responde expo_presentes con ellos.
   haySenal() decide si contesta o si no hay red. */
function base(lista, haySenal = () => true) {
  const datos = structuredClone(lista);
  const buscar = (a) => datos.find((v) => v.visita_id === a.p_visita);
  const conSenal = (f) => (a, n) => (haySenal() ? f(a, n) : SIN_RED);
  return {
    datos,
    rpc: {
      expo_equipo_lista: conSenal(() => EQUIPO),
      expo_presentes: conSenal(() => presentes(datos)),
      expo_anotarme: conSenal((a) => { const v = buscar(a); if (!v.recorrido.some((r) => r.id === a.p_equipo)) v.recorrido.push({ id: a.p_equipo, nombre: SOFIA.nombre, tomo_pedido: false }); return null; }),
      expo_bajarme: conSenal((a) => { const v = buscar(a); v.recorrido = v.recorrido.filter((r) => r.id !== a.p_equipo); return null; }),
      expo_tome_pedido: conSenal((a) => {
        const r = buscar(a).recorrido.find((x) => x.id === a.p_equipo);
        if (!r) return { error: 'expo_no_anotado' };   // como la base: solo quien se anotó
        r.tomo_pedido = a.p_tomo;
        return null;
      }),
    },
  };
}

test(`${ANCHO} px · el link del equipo guarda la clave, la saca de la URL y pregunta "¿Quién sos?"`, async () => {
  const b = base([TREBOL]);
  const { page } = await abrir({ ancho: ANCHO, hash: '#equipo=' + CLAVE, rpc: b.rpc });
  await page.waitForSelector('text=¿Quién sos?');
  assert.equal(await page.evaluate(() => location.hash), '#recorrido');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('expoEquipo'))), CLAVE);
  await page.waitForSelector('text=Sofía Giménez');
  await page.fill('#quien', 'so');
  assert.deepEqual(await page.$$eval('#listaEquipo .mr-resultado-razon', (e) => e.map((x) => x.textContent)), ['Soledad Ríos', 'Sofía Giménez']);
  await page.click('text=Sofía Giménez');
  await page.waitForSelector('.mr-presente');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('expoYo')).id), SOFIA.id);
  assert.equal(await page.textContent('#quiensoy'), 'Sofía G. ▾');
  await cerrar(page);
});

test(`${ANCHO} px · "Sofía G. ▾" abre "¿Quién sos?" y "Volver" deja la misma persona`, async () => {
  const b = base([TREBOL]);
  const { page } = await abrir({ ancho: ANCHO, hash: '#recorrido', local: comoSofia, rpc: b.rpc });
  await page.waitForSelector('.mr-presente');
  await page.click('#quiensoy');
  await page.waitForSelector('text=¿Quién sos?');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('expoYo')).id), SOFIA.id, 'se borró la persona elegida');
  await page.click('#volverRecorrido');
  await page.waitForSelector('.mr-presente');
  await cerrar(page);
});

test(`${ANCHO} px · presentes: los últimos arriba, "Lo atiende su vendedor" por defecto y quién hizo el recorrido`, async () => {
  // la base los manda desordenados: la pantalla igual pone arriba al último que llegó
  const b = base([PAPELTEC, TREBOL, COMEX, KALU]);
  const { page, errores } = await abrir({ ancho: ANCHO, hash: '#recorrido', local: comoSofia, rpc: b.rpc });
  await page.waitForSelector('.mr-presente');
  const t = await tarjetas(page);
  assert.deepEqual(t.map((x) => x.razon), [TREBOL.razon_social, KALU.razon_social, PAPELTEC.razon_social, COMEX.razon_social]);
  assert.equal(t[0].atiende, 'Lo atiende Diego Acosta, su vendedor');
  assert.equal(t[1].atiende, 'Sin vendedor asignado');
  assert.equal(t[2].atiende, 'Recorrido: Ana L. y Camila R.');
  assert.ok(t.every((x) => x.boton === 'Me anoto'));
  const meta = (n) => page.textContent(`.mr-presente:nth-of-type(${n}) .mr-presente-meta`);
  assert.match(await meta(1), /3 personas.*Zona Oeste/);
  assert.match(await meta(2), /Alta sin código/);
  assert.match(await meta(3), /Pedido: Camila R\./);
  assert.match(await meta(4), /Comex/);
  assert.deepEqual(await page.$$eval('.mr-chip', (c) => c.map((x) => x.textContent.replace(/\s+/g, ' ').trim())), ['Todos 4', 'Sin recorrido 3', 'Míos 0']);
  assert.match((await page.$$eval('.mr-cabecera-dato span', (s) => s.map((x) => x.textContent)))[0], /^Recorridos · \S+ \d+$/);
  assert.deepEqual(errores, []);
  await cerrar(page);
});

test(`${ANCHO} px · "Me anoto": se ve en el acto, manda solo la persona del equipo, deja el foco y ofrece deshacer`, async () => {
  const b = base([TREBOL, KALU]);
  const { page, llamadas } = await abrir({ ancho: ANCHO, hash: '#recorrido', local: comoSofia, rpc: b.rpc });
  await page.waitForSelector('.mr-presente');
  const enviado = respuestaDe(page, 'expo_anotarme');
  await page.click(`[data-anotar="${KALU.visita_id}"]`);
  await enviado;
  const t = await tarjetas(page);
  assert.equal(t[1].atiende, 'Recorrido: vos');
  assert.equal(t[1].mio, true);
  assert.equal(t[1].boton, 'Me bajo');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.bajar), KALU.visita_id, 'el foco se perdió al repintar');
  assert.equal(await page.textContent('.mr-tostada'), 'Te anotaste con Marroquineria Kalu Deshacer');
  assert.deepEqual(llamadas.find((l) => l.fn === 'expo_anotarme'), { fn: 'expo_anotarme', args: { p_clave: CLAVE, p_equipo: SOFIA.id, p_visita: KALU.visita_id } });

  const deshecho = respuestaDe(page, 'expo_bajarme');
  await page.click('#deshacer');
  await deshecho;
  await page.waitForFunction(() => !document.querySelector('.mr-presente--mio'));
  assert.equal((await tarjetas(page))[1].atiende, 'Sin vendedor asignado');
  assert.deepEqual(b.datos[1].recorrido, [], 'quedó anotada en la base');
  await cerrar(page);
});

test(`${ANCHO} px · la tostada de "Me anoto" se va sola a los pocos segundos`, async () => {
  const b = base([TREBOL]);
  const { page } = await abrir({ ancho: ANCHO, reloj: true, hash: '#recorrido', local: comoSofia, rpc: b.rpc });
  await page.waitForSelector('.mr-presente');
  await page.click(`[data-anotar="${TREBOL.visita_id}"]`);
  await page.waitForSelector('.mr-tostada');
  await page.clock.fastForward(7000);
  await page.waitForFunction(() => !document.querySelector('.mr-tostada'));
  await cerrar(page);
});

test(`${ANCHO} px · filtros: Sin recorrido y Míos (vacíos dicen qué hacer)`, async () => {
  const b = base([TREBOL, PAPELTEC]);
  const { page } = await abrir({ ancho: ANCHO, hash: '#recorrido', local: comoSofia, rpc: b.rpc });
  await page.waitForSelector('.mr-presente');
  await page.click('[data-filtro="mios"]');
  await page.waitForSelector('text=Todavía no te anotaste con nadie');
  await page.click('.mr-estado [data-filtro="sin"]');
  assert.deepEqual((await tarjetas(page)).map((x) => x.razon), [TREBOL.razon_social]);
  assert.equal(await page.getAttribute('.mr-chip[data-filtro="sin"]', 'aria-pressed'), 'true');
  await cerrar(page);

  const todosConRecorrido = await abrir({ ancho: ANCHO, hash: '#recorrido', local: comoSofia, rpc: base([PAPELTEC]).rpc });
  await todosConRecorrido.page.waitForSelector('.mr-presente');
  await todosConRecorrido.page.click('[data-filtro="sin"]');
  await todosConRecorrido.page.waitForSelector('text=Todos los presentes tienen recorrido');
  await cerrar(todosConRecorrido.page);
});

test(`${ANCHO} px · buscar presente filtra sin tildes ni mayúsculas`, async () => {
  const b = base([TREBOL, KALU, PAPELTEC]);
  const { page } = await abrir({ ancho: ANCHO, hash: '#recorrido', local: comoSofia, rpc: b.rpc });
  await page.waitForSelector('.mr-presente');
  await page.fill('#buscarPresente', 'trébol');
  assert.deepEqual((await tarjetas(page)).map((x) => x.razon), [TREBOL.razon_social]);
  await page.fill('#buscarPresente', 'zzz');
  await page.waitForSelector('text=No encontramos “zzz”');
  await cerrar(page);
});

test(`${ANCHO} px · "Tomé el pedido": solo en los míos, y se puede destildar`, async () => {
  const mia = { ...KALU, recorrido: [{ id: SOFIA.id, nombre: SOFIA.nombre, tomo_pedido: false }] };
  const b = base([TREBOL, mia]);
  const { page, llamadas } = await abrir({ ancho: ANCHO, hash: '#recorrido', local: comoSofia, rpc: b.rpc });
  await page.waitForSelector('.mr-presente');
  assert.equal(await page.$$eval('[data-pedido]', (c) => c.length), 1, 'aparece en presentes que no son míos');
  let enviado = respuestaDe(page, 'expo_tome_pedido');
  await page.check('[data-pedido]');
  await enviado;
  assert.deepEqual(llamadas.filter((l) => l.fn === 'expo_tome_pedido').at(-1).args, { p_clave: CLAVE, p_equipo: SOFIA.id, p_visita: KALU.visita_id, p_tomo: true });
  assert.match(await page.textContent('.mr-presente--mio .mr-presente-meta'), /Pedido: vos/);
  enviado = respuestaDe(page, 'expo_tome_pedido');
  await page.uncheck('[data-pedido]');
  await enviado;
  assert.equal(b.datos[1].recorrido[0].tomo_pedido, false);
  await cerrar(page);
});

test(`${ANCHO} px · sin señal: "Me anoto" se ve igual, queda en el celular y sale cuando vuelve`, async () => {
  let senal = true;
  const b = base([TREBOL], () => senal);
  const { page } = await abrir({ ancho: ANCHO, hash: '#recorrido', local: comoSofia, rpc: b.rpc });
  await page.waitForSelector('.mr-presente');
  senal = false;
  await page.click(`[data-anotar="${TREBOL.visita_id}"]`);
  await page.waitForSelector('text=Sin conexión.');
  assert.match(await texto(page), /Lo que anotes se envía cuando vuelva/);
  assert.equal((await tarjetas(page))[0].atiende, 'Recorrido: vos');
  assert.deepEqual(await fnsEnCola(page), ['expo_anotarme']);
  senal = true;
  await vuelveLaSenal(page);
  await colaVacia(page);
  assert.equal(b.datos[0].recorrido.length, 1);
  await cerrar(page);
});

test(`${ANCHO} px · sin señal: "Me anoto" y después "Me bajo": queda solo el "Me bajo" y nadie anotado`, async () => {
  let senal = true;
  const b = base([TREBOL], () => senal);
  const { page } = await abrir({ ancho: ANCHO, hash: '#recorrido', local: comoSofia, rpc: b.rpc });
  await page.waitForSelector('.mr-presente');
  senal = false;
  await page.click(`[data-anotar="${TREBOL.visita_id}"]`);
  await page.click(`[data-bajar="${TREBOL.visita_id}"]`);
  assert.deepEqual(await fnsEnCola(page), ['expo_bajarme'], 'el "Me anoto" viejo sigue en la cola');
  senal = true;
  await vuelveLaSenal(page);
  await colaVacia(page);
  assert.deepEqual(b.datos[0].recorrido, []);
  await cerrar(page);
});

test(`${ANCHO} px · "Me anoto" sin señal y "Tomé el pedido" ya con señal: salen en orden y queda el pedido`, async () => {
  let senal = true;
  const b = base([TREBOL], () => senal);
  const { page } = await abrir({ ancho: ANCHO, hash: '#recorrido', local: comoSofia, rpc: b.rpc });
  await page.waitForSelector('.mr-presente');
  senal = false;
  await page.click(`[data-anotar="${TREBOL.visita_id}"]`);
  await page.waitForSelector('[data-pedido]');
  senal = true;                                   // vuelve la señal, la cola todavía no reintentó
  await page.check('[data-pedido]');
  await colaVacia(page);
  assert.deepEqual(b.datos[0].recorrido.map((r) => [r.id, r.tomo_pedido]), [[SOFIA.id, true]], 'se perdió el pedido');
  await cerrar(page);
});

test(`${ANCHO} px · la actualización de cada 15 s no pisa un "Me anoto" que todavía está en camino`, async () => {
  let soltar;
  const espera = new Promise((ok) => { soltar = ok; });
  const b = base([TREBOL]);
  const lento = { ...b.rpc, expo_anotarme: async (a, n) => { await espera; return b.rpc.expo_anotarme(a, n); } };
  const { page } = await abrir({ ancho: ANCHO, reloj: true, hash: '#recorrido', local: comoSofia, rpc: lento });
  await page.waitForSelector('.mr-presente');
  await page.click(`[data-anotar="${TREBOL.visita_id}"]`);
  const refresco = respuestaDe(page, 'expo_presentes');
  await page.clock.fastForward(15000);
  await refresco;                                 // la base todavía no tiene el "Me anoto"
  assert.equal((await tarjetas(page))[0].boton, 'Me bajo', 'la actualización deshizo lo que se tocó');
  soltar();
  await colaVacia(page);
  await cerrar(page);
});

test(`${ANCHO} px · si la base rechaza lo que se tocó, lo dice y vuelve a lo que hay de verdad`, async () => {
  const b = base([TREBOL]);
  const { page } = await abrir({ ancho: ANCHO, hash: '#recorrido', local: comoSofia, rpc: { ...b.rpc, expo_anotarme: () => ({ error: 'expo_visita_invalida' }) } });
  await page.waitForSelector('.mr-presente');
  await page.click(`[data-anotar="${TREBOL.visita_id}"]`);
  await page.waitForSelector('text=Esa visita ya no está en la lista de hoy.');
  await page.waitForFunction(() => !document.querySelector('.mr-presente--mio'));
  assert.equal(await page.$('.mr-tostada'), null, 'la tostada sigue diciendo "Te anotaste"');
  await cerrar(page);
});

test(`${ANCHO} px · la lista se actualiza sola cada 15 segundos`, async () => {
  const b = base([TREBOL]);
  const { page, llamadas } = await abrir({ ancho: ANCHO, reloj: true, hash: '#recorrido', local: comoSofia, rpc: b.rpc });
  await page.waitForSelector('.mr-presente');
  const antes = llamadas.filter((l) => l.fn === 'expo_presentes').length;
  b.datos.unshift(structuredClone({ ...KALU, llegada: new Date().toISOString() }));
  const nueva = respuestaDe(page, 'expo_presentes');
  await page.clock.fastForward(15000);
  await nueva;
  assert.equal(llamadas.filter((l) => l.fn === 'expo_presentes').length, antes + 1);
  assert.equal((await tarjetas(page))[0].razon, KALU.razon_social);
  await cerrar(page);
});

test(`${ANCHO} px · sin señal al abrir: la lista guardada de hoy se usa y dice de cuándo es; la de ayer no`, async () => {
  const deHoy = { equipo: SOFIA.id, datos: presentes([TREBOL]), vistoEn: Date.now() - 3 * 60000 };
  const conHoy = await abrir({ ancho: ANCHO, hash: '#recorrido', local: { ...comoSofia, expoPresentes: deHoy }, rpc: base([], () => false).rpc });
  await conHoy.page.waitForSelector('text=Sin conexión.');
  assert.match(await texto(conHoy.page), /La lista es de hace 3 min\./);
  assert.equal((await tarjetas(conHoy.page))[0].razon, TREBOL.razon_social);
  await cerrar(conHoy.page);

  const deAyer = { equipo: SOFIA.id, datos: { ...presentes([TREBOL]), hoy: dia(-1) }, vistoEn: Date.now() - 86400000 };
  const conAyer = await abrir({ ancho: ANCHO, hash: '#recorrido', local: { ...comoSofia, expoPresentes: deAyer }, rpc: base([], () => false).rpc });
  await conAyer.page.waitForSelector('text=Sin conexión.');
  assert.equal(await conAyer.page.$('.mr-presente'), null, 'mostró la lista de ayer');
  await cerrar(conAyer.page);
});

test(`${ANCHO} px · antes de que llegue nadie: "Todavía no llegó nadie" con la hora de apertura`, async () => {
  const b = base([]);
  const { page } = await abrir({ ancho: ANCHO, hash: '#recorrido', local: comoSofia, rpc: b.rpc });
  await page.waitForSelector('text=Todavía no llegó nadie');
  assert.match(await texto(page), /Las puertas abren a las 9:00\. La lista se actualiza sola/);
  await cerrar(page);
});

test(`${ANCHO} px · una clave del equipo vencida: la borra y lo dice (en la lista y en "¿Quién sos?")`, async () => {
  const enLista = await abrir({ ancho: ANCHO, hash: '#recorrido', local: comoSofia, rpc: { expo_presentes: () => ({ error: 'expo_clave_invalida' }) } });
  await enLista.page.waitForSelector('text=Este link del equipo ya no sirve');
  assert.equal(await enLista.page.evaluate(() => localStorage.getItem('expoEquipo')), null);
  await cerrar(enLista.page);

  const enQuienSos = await abrir({ ancho: ANCHO, hash: '#equipo=' + CLAVE, rpc: { expo_equipo_lista: () => ({ error: 'expo_clave_invalida' }) } });
  await enQuienSos.page.waitForSelector('text=Este link del equipo ya no sirve');
  assert.equal(await enQuienSos.page.evaluate(() => localStorage.getItem('expoEquipo')), null);
  await cerrar(enQuienSos.page);
});

test(`${ANCHO} px · si la persona ya no está en el equipo, vuelve a "¿Quién sos?"`, async () => {
  const b = base([TREBOL]);
  const { page } = await abrir({ ancho: ANCHO, hash: '#recorrido', local: comoSofia, rpc: { ...b.rpc, expo_presentes: () => ({ error: 'expo_equipo_invalido' }) } });
  await page.waitForSelector('text=¿Quién sos?');
  assert.equal(await page.evaluate(() => localStorage.getItem('expoYo')), null);
  await cerrar(page);
});

test(`${ANCHO} px · nombres y datos de la base escapados en las tarjetas y en "¿Quién sos?"`, async () => {
  const malo = '<img src=x onerror="window.__xss=1">';
  const rara = visita(5, malo + 'ACME', { zona: malo, vendedor: malo, recorrido: [{ id: ANA.id, nombre: malo, tomo_pedido: true }] });
  const { page } = await abrir({
    ancho: ANCHO, hash: '#recorrido', local: comoSofia,
    rpc: { expo_presentes: () => presentes([rara, { ...TREBOL, vendedor: malo }]), expo_equipo_lista: () => [{ ...ANA, nombre: malo }] },
  });
  await page.waitForSelector('.mr-presente');
  assert.equal(await page.$('#app img:not(.mr-logo img)'), null, 'se interpretó HTML en las tarjetas');
  await page.click('#quiensoy');
  await page.waitForSelector('#listaEquipo .mr-resultado');
  assert.equal(await page.$('#app img:not(.mr-logo img)'), null, 'se interpretó HTML en ¿Quién sos?');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await cerrar(page);
});
