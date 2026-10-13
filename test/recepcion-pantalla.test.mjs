// Pantalla 4 · recepción en vivo (#recepcion): login con Google, el tablero
// del día y "Vincular un alta".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { abrir, desbordes, respuestaDe, SIN_RED, ANCHOS, hoy, dia } from './navegador.mjs';

const ESCRITORIO = 1280, CELULAR = 390;
const MAIL = 'recepcion@mooving.com.ar';
const SESION = { email: MAIL, access_token: 'tok-1', refresh_token: 'ref-1', vence: Date.UTC(2100, 0, 1) };
const conSesion = { expoSesion: SESION };
const a_las = (hhmm) => new Date(`${hoy()}T${hhmm}:00-03:00`);   // hoy, en hora argentina

const texto = (page) => page.textContent('#app');
const textos = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.trim()));
const cerrar = (page) => page.context().close();

// "Miércoles 15" / "Mié 15" de un día "2026-10-15", como la página
const fecha = (iso) => new Date(`${iso}T12:00:00Z`);
const diaLargo = (iso) => new Intl.DateTimeFormat('es-AR', { weekday: 'long', timeZone: 'UTC' }).format(fecha(iso)) + ' ' + fecha(iso).getUTCDate();
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const diaCorto = (iso) => capital(new Intl.DateTimeFormat('es-AR', { weekday: 'short', timeZone: 'UTC' }).format(fecha(iso)).replace('.', '')) + ' ' + fecha(iso).getUTCDate();

const falta = (razon, desde, hasta, extra = {}) => ({
  invitado_id: crypto.randomUUID(), razon_social: razon, localidad: 'Morón', zona: 'Zona Oeste', vendedor: 'Diego Acosta',
  desde: `${desde}:00:00`.slice(0, 8), hasta: `${hasta}:00:00`.slice(0, 8), ...extra,
});
const KALU = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001', empresa: 'Marroquinería Kalu', nombre: 'Silvina Fernández', categoria: 'cliente',
  cuit: '27-28455120-3', dia: hoy(), llegada: a_las('10:58').toISOString(), cantidad: 2,
};
const DON_PEPE = {
  id: 'aaaaaaaa-0000-4000-8000-000000000002', empresa: 'Juguetería Don Pepe', nombre: null, categoria: 'cliente_de_cliente',
  cuit: null, dia: hoy(), llegada: a_las('10:12').toISOString(), cantidad: 3,
};

/* Lo que devuelve expo_recepcion: el día del diseño (miércoles, día 2 de 3). */
function tablero(extra = {}) {
  const faltantes = [
    falta('ALTAMIRANO E HIJOS S.H. - LIBRERIA EL ATENEO DE MORON', '09', '10'),
    falta('BAZAR Y JUGUETERIA LOS PIBES DE IRIGOYEN S.R.L.', '09', '10', { localidad: 'Bernardo de Irigoyen', zona: 'Interior', vendedor: 'Paula Romero' }),
    falta('SOSA MARIANA BEATRIZ - LIBRERIA ARCO', '09', '10', { localidad: 'Quilmes', zona: 'Zona Sur', vendedor: 'Juan Pérez' }),
    ...['LIBRERIA SAN MARTIN DE TOURS S.R.L.', 'COOPERATIVA ESCOLAR NUESTRA SEÑORA DE LUJAN LTDA', 'PEREZ ROBERTO OMAR - JUGUETERIA PIRULO',
      'LIBRERIA UNO', 'LIBRERIA DOS', 'LIBRERIA TRES', 'LIBRERIA CUATRO'].map((r, i) => falta(r, '10', '11', i === 1 ? { vendedor: 'Martín Ibarra' } : {})),
    ...Array.from({ length: 9 }, (_, i) => falta(`LIBRERIA DE LAS ONCE ${i + 1}`, '11', '12')),
  ];
  return {
    estado: 'en_curso', anio: 2026, dias: [dia(-1), hoy(), dia(1)], hoy: hoy(), es_dia: true, hora_apertura: '09:00:00',
    cifras: { clientes: 63, personas: 131, sin_turno: 4, no_clientes: 11, no_clientes_personas: 16 },
    con_turno: 95, faltantes,
    altas: [KALU, DON_PEPE],
    no_clientes: [
      { categoria: 'comex', cantidad: 5, personas: 7 }, { categoria: 'proveedor', cantidad: 3, personas: 5 },
      { categoria: 'licencia', cantidad: 2, personas: 2 }, { categoria: 'cliente_de_cliente', cantidad: 1, personas: 2 },
    ],
    ayer: { dia: dia(-1), clientes: 88, personas: 186 },
    ...extra,
  };
}

// Espera a que pase algo que no depende de la página (por ejemplo, que ya
// haya salido un pedido: puede salir mientras carga, antes de esperarlo).
async function hasta(condicion, ms = 10000) {
  for (const fin = Date.now() + ms; !condicion(); ) {
    if (Date.now() > fin) throw new Error('hasta(): no pasó');
    await new Promise((ok) => setTimeout(ok, 20));
  }
}

const abrirRecepcion = (op = {}) => abrir({ hash: '#recepcion', local: conSesion, reloj: a_las('10:42'), ...op });

test(`${ESCRITORIO} px · escritorio: las cuatro cifras, faltantes por turno con su vendedor, altas sin código y no clientes`, async () => {
  const { page, llamadas, errores } = await abrirRecepcion({ ancho: ESCRITORIO, rpc: { expo_recepcion: () => tablero() } });
  await page.waitForSelector('.mr-cifra');
  assert.equal(await page.$eval('main', (m) => m.className), 'mr-pantalla mr-pantalla--ancha');
  assert.deepEqual(await textos(page, '.mr-cabecera-dato span'), [`Recepción · ${capital(diaLargo(hoy()))} · día 2 de 3`, 'Actualizado hace 0 s']);
  assert.deepEqual(await textos(page, '.mr-cifra'), [
    '63clientes llegaron · 4 sin turno hoy', '131personas · 2,1 por cliente',
    '11 · 16 pers.no clientes, fuera de las cifras', '19 de 95con turno hoy todavía no llegaron',
  ]);
  assert.equal(await page.$eval('.mr-cifra:last-child', (c) => c.classList.contains('mr-cifra--clave')), true);

  assert.deepEqual(await textos(page, 'section .mr-grupo-titulo'), [
    'Turno 9 a 10 h · faltan 3terminó hace 42 min', 'Turno 10 a 11 h · faltan 7en curso', 'Turno 11 a 12 h · 9más tarde',
  ]);
  const [primero] = await textos(page, 'section .mr-falta');
  assert.equal(primero, 'ALTAMIRANO E HIJOS S.H. - LIBRERIA EL ATENEO DE MORONMorón · Zona Oeste · Diego Acosta9 a 10 hAtrasado 1 h 42');
  assert.match((await textos(page, 'section .mr-falta'))[3], /En su turno$/);
  assert.equal(await page.textContent('[data-ver]'), 'Ver los 4 que faltan');
  assert.equal(await page.$$eval('[data-grupo="11:00:00-12:00:00"] .mr-falta', (l) => l.length), 0, 'los de más tarde van solo con la cuenta');

  assert.deepEqual(await textos(page, '[data-vincular]'), ['Vincular', 'Vincular']);
  const altas = await page.$$eval('.mr-falta:has([data-vincular])', (l) => l.map((x) => x.querySelector('.mr-falta-datos').textContent));
  assert.deepEqual(altas, ['Silvina Fernández · dice ser cliente · 10:58', 'viene con un cliente · 10:12']);
  assert.match(await texto(page), /Altas sin código · 2/);
  assert.match(await texto(page), /Sin código no entran en el cruce con facturación\./);
  assert.deepEqual(await textos(page, '.mr-cuenta'), ['5 · 7 pers.', '3 · 5 pers.', '2 · 2 pers.', '1 · 2 pers.']);
  assert.deepEqual(await textos(page, '.mr-falta-razon .mr-categoria'), ['Comex', 'Proveedor', 'Agente de licencia', 'Cliente de un cliente']);

  assert.deepEqual(llamadas.filter((l) => l.fn === 'expo_recepcion'), [{ fn: 'expo_recepcion', args: {}, auth: 'Bearer tok-1' }]);
  assert.deepEqual(errores, []);
  await cerrar(page);
});

test(`${ESCRITORIO} px · "Ver los 4 que faltan" abre el turno; el filtro por vendedor; los dos siguen al actualizarse`, async () => {
  // la segunda respuesta cambia una cifra: así el tablero se repinta de verdad
  const conUnoMas = (a, n) => { const t = tablero(); if (n > 1) t.cifras.clientes = 64; return t; };
  const { page, llamadas } = await abrirRecepcion({ ancho: ESCRITORIO, rpc: { expo_recepcion: conUnoMas } });
  await page.click('[data-ver]');
  assert.equal(await page.$$eval('[data-grupo="10:00:00-11:00:00"] .mr-falta', (l) => l.length), 7);
  assert.equal(await page.$('[data-ver]'), null);

  await page.selectOption('#vendedor', 'Martín Ibarra');
  assert.deepEqual(await textos(page, 'section .mr-grupo-titulo h3'), ['Turno 10 a 11 h · faltan 1']);
  assert.deepEqual(await textos(page, '#vendedor option'), ['Todos los vendedores', 'Diego Acosta', 'Juan Pérez', 'Martín Ibarra', 'Paula Romero']);

  await page.focus('#vendedor');
  const otra = respuestaDe(page, 'expo_recepcion');
  await page.clock.fastForward(30000);   // se actualiza sola
  await otra;
  assert.equal(llamadas.filter((l) => l.fn === 'expo_recepcion').length, 2);
  assert.match((await textos(page, '.mr-cifra'))[0], /^64/, 'no se repintó');
  assert.equal(await page.inputValue('#vendedor'), 'Martín Ibarra', 'el filtro se perdió al actualizarse');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'vendedor', 'el foco se perdió al actualizarse');
  await page.selectOption('#vendedor', '');
  assert.equal(await page.$$eval('[data-grupo="10:00:00-11:00:00"] .mr-falta', (l) => l.length), 7, 'el turno abierto se cerró');
  await cerrar(page);
});

test(`${CELULAR} px · celular: tres cifras con los atrasados, sin filtro, y las altas abajo`, async () => {
  const { page } = await abrirRecepcion({ ancho: CELULAR, rpc: { expo_recepcion: () => tablero() } });
  await page.waitForSelector('.mr-cifra');
  assert.equal(await page.$eval('main', (m) => m.className), 'mr-pantalla');
  assert.deepEqual(await textos(page, '.mr-cabecera-dato span'), [`Recepción · ${diaCorto(hoy())}`, 'hace 0 s']);
  assert.deepEqual(await textos(page, '.mr-cifra'), ['63clientes', '131personas', '19 de 95con turno hoy todavía no llegaron · 3 atrasados']);
  assert.equal(await page.$eval('.mr-cifras', (c) => c.className), 'mr-cifras mr-cifras--2');
  assert.equal(await page.$('#vendedor'), null);
  assert.equal(await page.textContent('h2'), 'Tenían turno hoy y no llegaron');
  assert.ok(await page.$('[data-vincular]'));
  assert.deepEqual(await desbordes(page), []);

  await page.clock.fastForward(10000);   // "hace 10 s" (el reloj de la página sigue corriendo: puede ser 11)
  assert.match((await textos(page, '.mr-cabecera-dato span'))[1], /^hace 1[01] s$/);
  await cerrar(page);
});

test(`${CELULAR} px · antes de abrir: a qué hora abre, cuántos tienen turno y cómo fue ayer`, async () => {
  const t = tablero({ cifras: { clientes: 0, personas: 0, sin_turno: 0, no_clientes: 0, no_clientes_personas: 0 } });
  const { page } = await abrirRecepcion({ ancho: CELULAR, reloj: a_las('08:41'), rpc: { expo_recepcion: () => t } });
  await page.waitForSelector('text=Abre a las 9:00');
  assert.match(await texto(page), /95 clientes tienen turno hoy\. El primero, de 9 a 10 h: 3 clientes\./);
  assert.equal(await page.textContent('.mr-cuerpo .mr-etiqueta'), `Ayer · ${diaLargo(dia(-1))}`);
  assert.deepEqual(await textos(page, '.mr-cifra'), ['88clientes', '186personas']);
  assert.equal((await textos(page, '.mr-cabecera-dato span'))[1], '8:41');
  await cerrar(page);
});

test(`${CELULAR} px · si no se puede actualizar, deja lo último con la hora y reintenta cada 30 s`, async () => {
  const { page } = await abrirRecepcion({ ancho: CELULAR, rpc: { expo_recepcion: (a, n) => (n === 2 ? SIN_RED : tablero()) } });
  await page.waitForSelector('.mr-cifra');
  await page.clock.fastForward(30000);
  await page.waitForSelector('text=No se pudo actualizar');
  assert.match(await texto(page), /Mostramos lo de las 10:42\. Reintentamos cada 30 s\./);
  assert.deepEqual((await textos(page, '.mr-cifra'))[0], '63clientes', 'se borró lo último que se vio');
  assert.equal((await textos(page, '.mr-cabecera-dato span'))[1], '10:42', 'con datos viejos la cabecera muestra la hora, no "hace"');
  await page.clock.fastForward(30000);
  await page.waitForFunction(() => !document.querySelector('#app').textContent.includes('No se pudo actualizar'));
  await cerrar(page);
});

test(`${CELULAR} px · llegaron todos: vacío feliz, la cifra sin resaltar y las altas que quedan`, async () => {
  const { page } = await abrirRecepcion({ ancho: CELULAR, rpc: { expo_recepcion: () => tablero({ faltantes: [] }) } });
  await page.waitForSelector('text=Llegaron todos los turnos de hoy');
  assert.match(await texto(page), /Quedan 2 altas sin código para vincular\./);
  assert.deepEqual((await textos(page, '.mr-cifra'))[2], '0 de 95faltantes');
  assert.equal(await page.$('.mr-cifra--clave'), null);
  await cerrar(page);
});

test(`${CELULAR} px · sin sesión: "Entrar con Google" con PKCE; vuelve, canjea el code y entra (sin dejar el code en la URL)`, async () => {
  let reto = null;
  const { page, llamadas, origen } = await abrir({
    ancho: CELULAR, hash: '#recepcion',
    authorize: (url) => { reto = url.searchParams.get('code_challenge'); return `${url.searchParams.get('redirect_to')}?code=codigo-de-google`; },
    auth: {
      'token?grant_type=pkce': (c) => (createHash('sha256').update(c.code_verifier).digest('base64url') === reto && c.auth_code === 'codigo-de-google'
        ? { access_token: 'tok-nuevo', refresh_token: 'ref-nuevo', expires_in: 3600, user: { email: MAIL } }
        : { http: 400 }),
    },
    rpc: { expo_recepcion: () => tablero() },
  });
  await page.waitForSelector('text=Entrar con Google');
  await page.click('#google');
  await page.waitForSelector('.mr-cifra');
  const [pedido] = llamadas.filter((l) => l.fn === 'auth:authorize').map((l) => new URL(l.url));
  assert.equal(pedido.searchParams.get('provider'), 'google');
  assert.equal(pedido.searchParams.get('code_challenge_method'), 's256');
  assert.equal(pedido.searchParams.get('redirect_to'), `${origen}/index.html`);
  assert.ok(reto && reto.length >= 43);
  assert.equal(await page.evaluate(() => location.search + location.hash), '#recepcion');
  assert.equal(await page.evaluate(() => localStorage.getItem('expoPkce')), null, 'quedó el verificador guardado');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('expoSesion')).email), MAIL);
  assert.equal(llamadas.find((l) => l.fn === 'expo_recepcion').auth, 'Bearer tok-nuevo');
  await cerrar(page);
});

test(`${CELULAR} px · un ?code= que no empezó en este navegador no se canjea; un #access_token pegado no se acepta`, async () => {
  const { page, llamadas } = await abrir({ ancho: CELULAR, hash: '?code=robado#recepcion', auth: { 'token?grant_type=pkce': () => ({ access_token: 'x', user: { email: MAIL } }) } });
  await page.waitForSelector('text=Entrar con Google');
  assert.equal(llamadas.some((l) => l.fn.startsWith('auth:token')), false, 'canjeó un code ajeno');
  assert.equal(await page.evaluate(() => location.search), '');

  await page.evaluate(() => { location.hash = 'access_token=robado&refresh_token=r&token_type=bearer'; });
  await page.waitForFunction(() => !location.hash.includes('access_token'));
  assert.equal(await page.evaluate(() => localStorage.getItem('expoSesion')), null);
  await cerrar(page);
});

test(`${CELULAR} px · si Google no completa el ingreso, lo dice y deja probar de nuevo`, async () => {
  const { page } = await abrir({ ancho: CELULAR, hash: '?error=access_denied&error_description=x#recepcion' });
  await page.waitForSelector('text=Google no completó el ingreso. Probá de nuevo.');
  assert.ok(await page.$('#google'));
  await cerrar(page);
});

test(`${CELULAR} px · una cuenta que no es admin no ve nada y puede entrar con otra`, async () => {
  const sesion = { expoSesion: { ...SESION, email: '<b>vendedor</b>@mooving.com.ar' } };
  const { page } = await abrirRecepcion({ ancho: CELULAR, local: sesion, rpc: { expo_recepcion: () => ({ error: 'expo_solo_admin' }) } });
  await page.waitForSelector('text=Tu cuenta no tiene acceso a recepción');
  assert.match(await texto(page), /Entraste como <b>vendedor<\/b>@mooving\.com\.ar/);
  assert.equal(await page.$('.mr-cifra'), null);
  const cierre = page.waitForRequest((r) => r.url().includes('/auth/v1/logout'));
  await page.click('#otra');
  await page.waitForSelector('text=Entrar con Google');
  assert.equal(await page.evaluate(() => localStorage.getItem('expoSesion')), null);
  // solo esta sesión: la misma cuenta sigue entrada en la app de pedidos y en otras compus
  assert.equal(new URL((await cierre).url()).searchParams.get('scope'), 'local');
  await cerrar(page);
});

test(`${CELULAR} px · la sesión se renueva sola (antes de vencer, o si la base dice que venció)`, async () => {
  const vencida = { expoSesion: { ...SESION, vence: 0 } };
  let token = 1;
  const { page, llamadas } = await abrirRecepcion({
    ancho: CELULAR, local: vencida,
    auth: { 'token?grant_type=refresh_token': () => ({ access_token: 'tok-' + (++token), refresh_token: 'ref-' + token, expires_in: 3600, user: { email: MAIL } }) },
    rpc: { expo_recepcion: (a, n) => (n === 2 ? { http: 401 } : tablero()) },
  });
  await page.waitForSelector('.mr-cifra');
  assert.deepEqual(llamadas.find((l) => l.fn === 'auth:token?grant_type=refresh_token').args, { refresh_token: 'ref-1' });
  assert.equal(llamadas.find((l) => l.fn === 'expo_recepcion').auth, 'Bearer tok-2');

  const conElNuevo = page.waitForResponse((r) => r.url().endsWith('/rpc/expo_recepcion') && r.request().headers().authorization === 'Bearer tok-3');
  await page.clock.fastForward(30000);   // esta vez la base dice 401: renueva y reintenta
  await conElNuevo;
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('expoSesion')).access_token), 'tok-3');
  const pedidos = llamadas.filter((l) => l.fn === 'expo_recepcion').map((l) => l.auth);
  assert.deepEqual(pedidos, ['Bearer tok-2', 'Bearer tok-2', 'Bearer tok-3']);
  assert.equal(await page.$('text=No se pudo actualizar'), null);
  await cerrar(page);
});

test(`${CELULAR} px · si la sesión no se puede renovar, pide entrar de nuevo (y la lista de clientes nunca queda guardada)`, async () => {
  let renovar = () => ({ access_token: 'tok-2', refresh_token: 'ref-2', expires_in: 3600, user: { email: MAIL } });
  const { page } = await abrirRecepcion({
    ancho: CELULAR, local: { expoSesion: { ...SESION, vence: 0 } },
    auth: { 'token?grant_type=refresh_token': () => renovar() },
    rpc: { expo_recepcion: (a, n) => (n === 1 ? tablero() : { http: 401 }) },
  });
  await page.waitForSelector('.mr-cifra');
  const guardado = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  assert.equal(guardado.includes('ALTAMIRANO') || guardado.includes('Kalu'), false, 'la lista de clientes quedó en la compu');
  renovar = () => ({ http: 400 });   // la sesión ya no sirve (la cerraron en Supabase)
  await page.clock.fastForward(30000);
  await page.waitForSelector('text=Tu sesión venció. Entrá de nuevo.');
  assert.equal(await page.evaluate(() => localStorage.getItem('expoSesion')), null);
  assert.equal(await page.$('.mr-cifra'), null);
  await cerrar(page);
});

test(`${ESCRITORIO} px · Vincular: ficha del alta, busca en Finnegans por CUIT y nombre, y vincula al elegido`, async () => {
  const opciones = [
    { codigo_erp: '15877', razon_social: 'FERNANDEZ SILVINA - MARROQUINERIA KALU', localidad: 'Caballito', zona: 'CABA', vendedor: 'Laura Benítez', coincide_cuit: true },
    { codigo_erp: '31220', razon_social: 'KALU ACCESORIOS S.R.L.', localidad: 'Morón', zona: 'Zona Oeste', vendedor: 'Diego Acosta', coincide_cuit: false },
  ];
  const { page, llamadas } = await abrirRecepcion({
    ancho: ESCRITORIO,
    rpc: { expo_recepcion: () => tablero(), expo_buscar_cliente: () => opciones, expo_vincular: () => 'x' },
  });
  await page.click(`[data-vincular="${KALU.id}"]`);
  await page.waitForSelector('dialog[open] .mr-opciones-vinculo');
  assert.equal(await page.textContent('dialog .mr-etiqueta'), `Alta sin código · ${diaCorto(hoy())}, 10:58`);
  assert.equal(await page.textContent('dialog h2'), 'Marroquinería Kalu');
  assert.deepEqual(await textos(page, 'dialog .mr-ficha dt, dialog .mr-ficha dd'),
    ['Se registró', 'Silvina Fernández', 'Dijo ser', 'Cliente de Mooving', 'CUIT que cargó', '27-28455120-3', 'Vinieron', '2 personas']);
  assert.equal(await page.inputValue('[data-v="buscar"]'), 'kalu');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.v), 'buscar', 'el foco no fue a la búsqueda');
  assert.deepEqual(llamadas.find((l) => l.fn === 'expo_buscar_cliente'),
    { fn: 'expo_buscar_cliente', args: { p_texto: 'kalu', p_cuit: '27-28455120-3' }, auth: 'Bearer tok-1' });
  assert.deepEqual(await textos(page, 'dialog .mr-opciones-vinculo label'), [
    'FERNANDEZ SILVINA - MARROQUINERIA KALUCoincide el CUITCód. 15877 · Caballito · CABA · Laura Benítez',
    'KALU ACCESORIOS S.R.L.Cód. 31220 · Morón · Zona Oeste · Diego Acosta',
  ]);
  assert.equal(await page.textContent('[data-v="vincular"]'), 'Vincular a 15877');
  await page.check('input[value="31220"]');
  assert.equal(await page.textContent('[data-v="vincular"]'), 'Vincular a 31220');
  await page.check('input[value="15877"]');

  const actualizada = respuestaDe(page, 'expo_recepcion');
  await page.click('[data-v="vincular"]');
  await actualizada;
  assert.equal(await page.$('dialog'), null, 'la hoja quedó abierta');
  assert.deepEqual(llamadas.find((l) => l.fn === 'expo_vincular'), { fn: 'expo_vincular', args: { p_alta: KALU.id, p_codigo: '15877' }, auth: 'Bearer tok-1' });
  await cerrar(page);
});

test(`${ESCRITORIO} px · "No es cliente" / "Es cliente nuevo"; si otra persona ya la resolvió, lo dice y actualiza`, async () => {
  const { page, llamadas } = await abrirRecepcion({
    ancho: ESCRITORIO,
    rpc: { expo_recepcion: () => tablero(), expo_buscar_cliente: () => [], expo_marcar_alta: (a) => (a.p_estado === 'no_cliente' ? { error: 'expo_alta_no_disponible' } : null) },
  });
  await page.click(`[data-vincular="${DON_PEPE.id}"]`);
  await page.waitForSelector('text=No encontramos “pepe”');
  assert.equal(await page.isDisabled('[data-v="vincular"]'), true);
  const actualizada = respuestaDe(page, 'expo_recepcion');
  await page.click('[data-marcar="no_cliente"]');
  await page.waitForSelector('text=Esta alta ya la resolvió otra persona de recepción.');
  await actualizada;
  assert.ok(await page.$('dialog[open]'), 'cerró la hoja sin decir qué pasó');

  await page.click('[data-marcar="cliente_nuevo"]');
  await page.waitForFunction(() => !document.querySelector('dialog'));
  assert.deepEqual(llamadas.filter((l) => l.fn === 'expo_marcar_alta').map((l) => l.args),
    [{ p_alta: DON_PEPE.id, p_estado: 'no_cliente' }, { p_alta: DON_PEPE.id, p_estado: 'cliente_nuevo' }]);
  await cerrar(page);
});

test(`${ESCRITORIO} px · los nombres que vienen de la base se muestran como texto, nunca como HTML`, async () => {
  const raro = '<img src=x onerror="window.pwned=1">';
  const t = tablero({
    faltantes: [falta(raro, '09', '10', { vendedor: raro, localidad: raro })],
    altas: [{ ...KALU, empresa: raro, nombre: raro, cuit: raro }],
  });
  const { page } = await abrirRecepcion({
    ancho: ESCRITORIO,
    rpc: { expo_recepcion: () => t, expo_buscar_cliente: () => [{ codigo_erp: '1', razon_social: raro, localidad: raro, zona: null, vendedor: null, coincide_cuit: false }] },
  });
  await page.waitForSelector('.mr-cifra');
  await page.click('[data-vincular]');
  await page.fill('[data-v="buscar"]', 'abc');   // el "CUIT" raro no alcanza para buscar
  await page.waitForSelector('dialog .mr-opciones-vinculo');
  assert.equal(await page.$$eval('img:not(.mr-logo img)', (l) => l.length), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.match(await page.textContent('dialog h2'), /<img/);
  await cerrar(page);
});

for (const ancho of [...ANCHOS, 768, ESCRITORIO]) {
  test(`${ancho} px · recepción y la hoja de vincular: nada se corta`, async () => {
    const { page } = await abrirRecepcion({ ancho, rpc: { expo_recepcion: () => tablero(), expo_buscar_cliente: () => [] } });
    await page.waitForSelector('.mr-cifra');
    assert.deepEqual(await desbordes(page), []);
    await page.click(`[data-vincular="${KALU.id}"]`);
    await page.waitForSelector('dialog[open] [data-v="resultados"] p');
    const fuera = await page.evaluate(() => {
      const ancho = document.documentElement.clientWidth;
      return [...document.querySelectorAll('dialog, dialog *')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width && (r.right > ancho + 0.5 || r.left < -0.5);
      }).map((el) => el.tagName.toLowerCase() + '.' + el.className);
    });
    assert.deepEqual(fuera, []);
    await cerrar(page);
  });
}

test(`${CELULAR} px · si tocan "Salir" mientras se renueva la sesión, lo renovado no queda guardado (y se cierra)`, async () => {
  let soltar;
  const demorada = new Promise((ok) => { soltar = ok; });
  const { page, llamadas } = await abrirRecepcion({
    ancho: CELULAR, local: { expoSesion: { ...SESION, vence: 0 } },
    auth: { 'token?grant_type=refresh_token': async () => { await demorada; return { access_token: 'tok-2', refresh_token: 'ref-2', expires_in: 3600, user: { email: MAIL } }; } },
    rpc: { expo_recepcion: () => tablero() },
  });
  await hasta(() => llamadas.some((l) => l.fn === 'auth:token?grant_type=refresh_token'));
  await page.click('#salir');
  await page.waitForSelector('text=Entrar con Google');
  const cierre = page.waitForRequest((r) => r.url().includes('/auth/v1/logout') && r.headers().authorization === 'Bearer tok-2');
  soltar();
  await cierre;   // la sesión que llegó tarde se cierra en Supabase
  assert.equal(await page.evaluate(() => localStorage.getItem('expoSesion')), null, 'la sesión volvió a quedar guardada');
  await cerrar(page);
});

test(`${ESCRITORIO} px · si la sesión se cae con la hoja abierta, la hoja se cierra (no queda encima del login)`, async () => {
  const { page } = await abrirRecepcion({
    ancho: ESCRITORIO,
    auth: { 'token?grant_type=refresh_token': () => ({ http: 400 }) },
    rpc: { expo_recepcion: (a, n) => (n === 1 ? tablero() : { http: 401 }), expo_buscar_cliente: () => [] },
  });
  await page.click(`[data-vincular="${KALU.id}"]`);
  await page.waitForSelector('dialog[open]');
  await page.clock.fastForward(30000);
  await page.waitForSelector('text=Tu sesión venció. Entrá de nuevo.');
  assert.equal(await page.$('dialog'), null, 'la hoja quedó abierta encima del login');
  await cerrar(page);
});

test(`${ESCRITORIO} px · mientras vincula, la hoja queda quieta (ni otra opción ni Escape); si falla, el botón dice el código que manda`, async () => {
  const opciones = [
    { codigo_erp: '15877', razon_social: 'FERNANDEZ SILVINA - MARROQUINERIA KALU', localidad: null, zona: null, vendedor: null, coincide_cuit: true },
    { codigo_erp: '31220', razon_social: 'KALU ACCESORIOS S.R.L.', localidad: null, zona: null, vendedor: null, coincide_cuit: false },
  ];
  let soltar;
  const demorada = new Promise((ok) => { soltar = ok; });
  const { page, llamadas } = await abrirRecepcion({
    ancho: ESCRITORIO,
    rpc: {
      expo_recepcion: () => tablero(), expo_buscar_cliente: () => opciones,
      expo_vincular: async (a, n) => { if (n === 1) { await demorada; return SIN_RED; } return 'x'; },
    },
  });
  await page.click(`[data-vincular="${KALU.id}"]`);
  await page.waitForSelector('dialog .mr-opciones-vinculo');
  await page.click('[data-v="vincular"]');
  assert.equal(await page.isDisabled('input[value="31220"]'), true, 'se puede cambiar de opción mientras guarda');
  assert.equal(await page.isDisabled('[data-v="buscar"]'), true);
  await page.keyboard.press('Escape');
  assert.ok(await page.$('dialog[open]'), 'Escape cerró la hoja mientras guardaba');

  soltar();
  await page.waitForSelector('text=No se pudo guardar. Revisá la conexión y probá de nuevo.');
  assert.equal(await page.textContent('[data-v="vincular"]'), 'Vincular a 15877');
  await page.check('input[value="31220"]');
  assert.equal(await page.textContent('[data-v="vincular"]'), 'Vincular a 31220');
  await page.click('[data-v="vincular"]');
  await page.waitForFunction(() => !document.querySelector('dialog'));
  assert.deepEqual(llamadas.filter((l) => l.fn === 'expo_vincular').map((l) => l.args.p_codigo), ['15877', '31220']);
  await cerrar(page);
});

test(`${ESCRITORIO} px · una actualización que llega tarde no pisa la de después (el alta vinculada no vuelve)`, async () => {
  let soltar;
  const demorada = new Promise((ok) => { soltar = ok; });
  const { page } = await abrirRecepcion({
    ancho: ESCRITORIO,
    rpc: {
      expo_recepcion: async (a, n) => {
        if (n === 2) { await demorada; return tablero(); }   // la del reloj, con la red lenta: todavía con Kalu
        return n === 1 ? tablero() : tablero({ altas: [DON_PEPE] });
      },
      expo_buscar_cliente: () => [{ codigo_erp: '15877', razon_social: 'KALU', localidad: null, zona: null, vendedor: null, coincide_cuit: true }],
      expo_vincular: () => 'x',
    },
  });
  await page.waitForSelector('.mr-cifra');
  const lenta = page.waitForRequest((r) => r.url().endsWith('/rpc/expo_recepcion'));
  await page.clock.fastForward(30000);
  const pedidoLento = await lenta;
  await page.click(`[data-vincular="${KALU.id}"]`);
  await page.waitForSelector('dialog .mr-opciones-vinculo');
  await page.click('[data-v="vincular"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-vincular]').length === 1);
  const tardia = page.waitForResponse((r) => r.request() === pedidoLento);
  soltar();
  await tardia;
  await page.evaluate(() => new Promise((ok) => setTimeout(ok, 50)));
  assert.equal(await page.$$eval('[data-vincular]', (l) => l.length), 1, 'el alta ya vinculada volvió a la lista');
  await cerrar(page);
});

test(`${ESCRITORIO} px · el filtro por vendedor es de escritorio: al pasar a celular se ven todos`, async () => {
  const { page } = await abrirRecepcion({ ancho: ESCRITORIO, rpc: { expo_recepcion: () => tablero() } });
  await page.selectOption('#vendedor', 'Martín Ibarra');
  await page.setViewportSize({ width: CELULAR, height: 800 });
  await page.waitForFunction(() => document.querySelector('main').className === 'mr-pantalla');
  assert.deepEqual(await textos(page, '.mr-grupo-titulo h3'), [
    'Turno 9 a 10 h · faltan 3', 'Turno 10 a 11 h · faltan 7', 'Turno 11 a 12 h · 9', 'Altas sin código · 2', 'No clientes hoy',
  ]);
  await cerrar(page);
});

test(`${CELULAR} px · hoy no hay expo: si todavía no empezó dice "empieza"; entre días, "sigue"`, async () => {
  for (const [dias, verbo] of [[[dia(2), dia(3)], 'empieza'], [[dia(-1), dia(2)], 'sigue']]) {
    const { page } = await abrirRecepcion({ ancho: CELULAR, rpc: { expo_recepcion: () => tablero({ es_dia: false, dias, ayer: null }) } });
    await page.waitForSelector('text=Hoy no hay expo');
    assert.match(await texto(page), new RegExp(`La expo 2026 ${verbo} el ${diaLargo(dia(2))}\\.`));
    await cerrar(page);
  }
});

test('320 px · "Tu cuenta no tiene acceso" con un mail largo y el login con error: nada se corta', async () => {
  const largo = { expoSesion: { ...SESION, email: 'nombre.apellidomaterno.apellidopaterno@distribuidoramooving.com.ar' } };
  let { page } = await abrirRecepcion({ ancho: 320, local: largo, rpc: { expo_recepcion: () => ({ error: 'expo_solo_admin' }) } });
  await page.waitForSelector('text=Tu cuenta no tiene acceso a recepción');
  assert.deepEqual(await desbordes(page), []);
  await cerrar(page);
  ({ page } = await abrir({ ancho: 320, hash: '?error=access_denied#recepcion' }));
  await page.waitForSelector('text=Google no completó el ingreso');
  assert.deepEqual(await desbordes(page), []);
  await cerrar(page);
});

test(`${CELULAR} px · una renovación de sesión que no contesta no frena la recepción: corta y avisa`, async () => {
  const { page, llamadas } = await abrirRecepcion({
    ancho: CELULAR, local: { expoSesion: { ...SESION, vence: 0 } },
    auth: { 'token?grant_type=refresh_token': () => new Promise(() => {}) },   // la red de la expo la deja colgada
    rpc: { expo_recepcion: () => tablero() },
  });
  await hasta(() => llamadas.some((l) => l.fn === 'auth:token?grant_type=refresh_token'));
  await page.clock.fastForward(9000);   // más que ESPERA_RED_MS
  await page.waitForSelector('text=No se pudo cargar la recepción');
  assert.match(await texto(page), /Reintentamos cada 30 s\./);
  await cerrar(page);
});

test(`${ESCRITORIO} px · la hoja no deja nada elegido si no coincide el CUIT (vincular no se deshace), y no busca por "srl"`, async () => {
  const arco = { ...KALU, id: 'aaaaaaaa-0000-4000-8000-000000000003', empresa: 'Librería Arco S.R.L.', cuit: null };
  const opciones = [
    { codigo_erp: '100', razon_social: 'ABRAHAM HNOS S.R.L.', localidad: null, zona: null, vendedor: null, coincide_cuit: false },
    { codigo_erp: '200', razon_social: 'LIBRERIA ARCO S.R.L.', localidad: null, zona: null, vendedor: null, coincide_cuit: false },
  ];
  const { page, llamadas } = await abrirRecepcion({
    ancho: ESCRITORIO, rpc: { expo_recepcion: () => tablero({ altas: [arco] }), expo_buscar_cliente: () => opciones, expo_vincular: () => 'x' },
  });
  await page.click(`[data-vincular="${arco.id}"]`);
  await page.waitForSelector('dialog .mr-opciones-vinculo');
  assert.equal(await page.inputValue('[data-v="buscar"]'), 'arco', 'busca por la forma societaria');
  assert.equal(await page.$('dialog input[type=radio]:checked'), null, 'dejó elegido el primero de la lista');
  assert.equal(await page.isDisabled('[data-v="vincular"]'), true);
  await page.check('input[value="200"]');
  assert.equal(await page.textContent('[data-v="vincular"]'), 'Vincular a 200');
  assert.equal(llamadas.filter((l) => l.fn === 'expo_vincular').length, 0);
  await cerrar(page);
});

test(`${ESCRITORIO} px · la hoja no busca con menos de 2 letras (lo dice, sin llamar a la base)`, async () => {
  const sinCuit = { ...KALU, cuit: null };
  const { page, llamadas } = await abrirRecepcion({ ancho: ESCRITORIO, rpc: { expo_recepcion: () => tablero({ altas: [sinCuit] }), expo_buscar_cliente: () => [] } });
  await page.click(`[data-vincular="${KALU.id}"]`);
  await page.waitForSelector('dialog [data-v="resultados"] p');
  const antes = llamadas.filter((l) => l.fn === 'expo_buscar_cliente').length;
  await page.fill('[data-v="buscar"]', 'k');
  await page.waitForSelector('text=Escribí al menos 2 letras, el código o el CUIT.');
  await page.evaluate(() => new Promise((ok) => setTimeout(ok, 400)));
  assert.equal(llamadas.filter((l) => l.fn === 'expo_buscar_cliente').length, antes, 'llamó a la base con una sola letra');
  await cerrar(page);
});

test(`${CELULAR} px · "Entrar con Google" deja elegir la cuenta (en la compu compartida se ve con cuál se entra)`, async () => {
  const { page, llamadas } = await abrir({ ancho: CELULAR, hash: '#recepcion', authorize: () => null });
  await page.click('#google');
  await hasta(() => llamadas.some((l) => l.fn === 'auth:authorize'));
  assert.equal(new URL(llamadas.find((l) => l.fn === 'auth:authorize').url).searchParams.get('prompt'), 'select_account');
  await cerrar(page);
});

test(`${CELULAR} px · dos pestañas que renuevan la sesión a la vez: las dos siguen adentro`, async () => {
  let soltar;
  const demorada = new Promise((ok) => { soltar = ok; });
  let n = 1;
  const { page, contexto, llamadas } = await abrirRecepcion({
    ancho: CELULAR, local: { expoSesion: { ...SESION, vence: 0 } },
    auth: { 'token?grant_type=refresh_token': async () => { await demorada; n++; return { access_token: 'tok-' + n, refresh_token: 'ref-' + n, expires_in: 3600, user: { email: MAIL } }; } },
    rpc: { expo_recepcion: () => tablero() },
  });
  const otra = await contexto.newPage();   // la segunda pestaña, con la misma sesión vencida
  await otra.goto(page.url());
  await hasta(() => llamadas.filter((l) => l.fn === 'auth:token?grant_type=refresh_token').length === 2);
  soltar();
  await page.waitForSelector('.mr-cifra');
  await otra.waitForSelector('.mr-cifra');
  assert.equal(llamadas.some((l) => l.fn.startsWith('auth:logout')), false, 'una pestaña cerró la sesión de la otra');
  assert.ok(await page.evaluate(() => localStorage.getItem('expoSesion')), 'se borró la sesión');
  await cerrar(page);
});

test('320 px · la hoja con un nombre largo: la × no se achica ni se va, y el CUIT no se parte', async () => {
  const largo = { ...KALU, empresa: 'DISTRIBUIDORA PAPELERIA UNIVERSITARIA EL BONETE' };
  const { page } = await abrirRecepcion({ ancho: 320, rpc: { expo_recepcion: () => tablero({ altas: [largo] }), expo_buscar_cliente: () => [] } });
  await page.click(`[data-vincular="${KALU.id}"]`);
  await page.waitForSelector('dialog[open] [data-v="resultados"] p');
  const x = await page.$eval('.mr-hoja-cerrar', (b) => { const r = b.getBoundingClientRect(); return { ancho: r.width, derecha: r.right }; });
  assert.ok(x.ancho >= 40, `la × mide ${x.ancho} px`);
  assert.ok(x.derecha <= 320, 'la × se sale de la pantalla');
  const cuit = await page.$eval('.mr-ficha dd .mr-num', (e) => e.getClientRects().length);
  assert.equal(cuit, 1, 'el CUIT se parte en dos renglones');
  await cerrar(page);
});

test(`${ESCRITORIO} px · en la compu, sin datos para mostrar, la portada de marca: entrar con Google y "No hay una expo abierta" (con Salir)`, async () => {
  let { page } = await abrir({ ancho: ESCRITORIO, hash: '#recepcion' });
  await page.waitForSelector('.portada-recepcion');
  assert.equal(await page.textContent('.portada-nombre'), 'Mooving' + 'Recepción');
  assert.ok(await page.$('.portada-recepcion #google'), 'el botón de Google no está en la portada');
  await cerrar(page);

  ({ page } = await abrirRecepcion({ ancho: ESCRITORIO, rpc: { expo_recepcion: () => ({ estado: 'sin_edicion', hoy: hoy() }) } }));
  await page.waitForSelector('.portada-recepcion');
  assert.match(await texto(page), /No hay una expo abierta/);
  assert.equal(await page.isVisible('.pie-salir'), false, 'quedan dos "Salir"');
  await page.click('[data-salir]');
  await page.waitForSelector('#google');
  assert.equal(await page.evaluate(() => localStorage.getItem('expoSesion')), null);
  await cerrar(page);
});

test(`${CELULAR} px · en el celular, sin datos, el estado de siempre (sin portada)`, async () => {
  const { page } = await abrirRecepcion({ ancho: CELULAR, rpc: { expo_recepcion: () => ({ estado: 'sin_edicion', hoy: hoy() }) } });
  await page.waitForSelector('text=No hay una expo abierta');
  assert.equal(await page.$('.portada-recepcion'), null);
  assert.equal(await page.isVisible('.pie-salir'), true);
  await cerrar(page);
});

for (const ancho of [768, 1024, ESCRITORIO]) {
  test(`${ancho} px · la portada: nada se corta`, async () => {
    for (const op of [{ hash: '#recepcion' }, { hash: '#recepcion', local: conSesion, rpc: { expo_recepcion: () => tablero({ es_dia: false, dias: [dia(2), dia(3)] }) } }]) {
      const { page } = await abrir({ ancho, alto: 700, ...op });
      await page.waitForSelector('.portada-recepcion');
      assert.deepEqual(await desbordes(page), []);
      await cerrar(page);
    }
  });
}
