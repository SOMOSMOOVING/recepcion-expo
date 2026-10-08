// Pantalla 1 · check-in del cliente (#t=TOKEN).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrir, cola, vuelveLaSenal, TOKEN, CLAVE_CARTEL, SIN_RED, enCurso, previa, dia, hoy } from './navegador.mjs';

const ANCHO = 390;   // el ancho de estos tests; los demás anchos están en anchos.test.mjs
const OTRO_TOKEN = 'e'.repeat(32);

const registrada = (args, extra = {}) => ({
  nueva: true, dia: hoy(), llegada: new Date().toISOString(), cantidad: args.p_cantidad,
  razon_social: 'MINUCHIN MARTA LILIANA - LIBRERIA PAPELTEC', nombre_credencial: 'LIBRERÍA PAPELTEC', ...extra,
});
const texto = (page) => page.textContent('#app');
const lineas = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.trim()));
const cerrar = (page) => page.context().close();

test(`${ANCHO} px · sin registrar: razón social arriba, contador con 2 elegido y el botón repite la cantidad`, async () => {
  const { page, errores } = await abrir({ ancho: ANCHO, hash: '#t=' + TOKEN, rpc: { expo_ver_invitado: () => enCurso() } });
  await page.waitForSelector('#principal');
  assert.deepEqual(await lineas(page, '.mr-razon span'), ['MINUCHIN MARTA LILIANA', 'LIBRERIA PAPELTEC']);
  assert.equal(await page.isChecked('input[value="2"]'), true);
  assert.equal(await page.textContent('#principal'), 'Estoy acá · somos 2');
  await page.click('input[value="1"]');
  assert.equal(await page.textContent('#principal'), 'Estoy acá · vengo solo');
  assert.equal(await page.textContent('.mr-barra-nota'), 'Tu turno: hoy de 10 a 11 h');
  const cabecera = await lineas(page, '.mr-cabecera-dato span');
  assert.match(cabecera[0], /^Expo · \S+ \d+$/);
  assert.equal(cabecera[1], 'Día 2 de 3');
  assert.deepEqual(errores, []);
  await cerrar(page);
});

test(`${ANCHO} px · registrarse: "Bienvenidos, ya pueden pasar" con la credencial`, async () => {
  const { page, llamadas } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN,
    rpc: { expo_ver_invitado: () => enCurso(), expo_registrar_visita: (a) => registrada(a) },
  });
  await page.click('#principal');
  await page.waitForSelector('text=Bienvenidos');
  assert.match(await texto(page), /2 personas/);
  assert.match(await texto(page), /Tu credencial dice LIBRERÍA PAPELTEC/);
  const r = llamadas.find((l) => l.fn === 'expo_registrar_visita');
  assert.deepEqual(r.args, { p_token: TOKEN, p_cantidad: 2 }, 'con señal no manda la hora del celular');
  await cerrar(page);
});

test(`${ANCHO} px · el mismo día no se registra dos veces: si ya estaban, lo dice`, async () => {
  const { page } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN,
    rpc: { expo_ver_invitado: () => enCurso(), expo_registrar_visita: (a) => registrada(a, { nueva: false, cantidad: 3 }) },
  });
  await page.click('#principal');
  await page.waitForSelector('text=Ya están registrados hoy');
  assert.match(await texto(page), /3 personas/);
  assert.doesNotMatch(await texto(page), /Bienvenidos/);
  await cerrar(page);
});

test(`${ANCHO} px · al volver a abrir el link el mismo día: "Ya están registrados hoy" y corregir la cantidad`, async () => {
  const visita = { llegada: new Date().toISOString(), cantidad: 2 };
  const { page, llamadas } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN,
    rpc: {
      expo_ver_invitado: () => enCurso({ visita_hoy: visita }),
      expo_corregir_cantidad: (a) => ({ dia: hoy(), llegada: visita.llegada, cantidad: a.p_cantidad }),
    },
  });
  await page.waitForSelector('text=Ya están registrados hoy');
  assert.equal(await page.$('input[type=radio]'), null, 'no ofrece registrarse de nuevo');
  await page.click('#corregir');
  await page.click('input[value="4"]');
  assert.equal(await page.textContent('#principal'), 'Guardar · somos 4');
  await page.click('#principal');
  await page.waitForSelector('text=4 personas');
  assert.deepEqual(llamadas.at(-1), { fn: 'expo_corregir_cantidad', args: { p_token: TOKEN, p_cantidad: 4 } });
  await cerrar(page);
});

test(`${ANCHO} px · dos toques seguidos registran una sola vez`, async () => {
  let soltar;
  const espera = new Promise((ok) => { soltar = ok; });
  const { page, llamadas } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN,
    rpc: { expo_ver_invitado: () => enCurso(), expo_registrar_visita: async (a) => { await espera; return registrada(a); } },
  });
  await page.waitForSelector('#principal');
  await page.click('#principal');
  await page.click('#principal', { force: true });
  assert.equal(await page.getAttribute('#principal', 'aria-busy'), 'true');
  soltar();
  await page.waitForSelector('text=Bienvenidos');
  assert.equal(llamadas.filter((l) => l.fn === 'expo_registrar_visita').length, 1);
  await cerrar(page);
});

test(`${ANCHO} px · sin señal: deja pasar, guarda en el celular con la hora y reintenta solo`, async () => {
  let haySenal = false;
  const { page, llamadas } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN,
    rpc: { expo_ver_invitado: () => enCurso(), expo_registrar_visita: (a) => (haySenal ? registrada(a) : SIN_RED) },
  });
  await page.click('input[value="3"]');
  await page.click('#principal');
  await page.waitForSelector('text=No hay señal, pero ya pueden pasar');
  assert.match(await texto(page), /3 personas/);
  assert.match(await texto(page), /Reintentando enviar/);
  const [guardado] = await cola(page);
  assert.equal(guardado.fn, 'expo_registrar_visita');
  assert.equal(guardado.args.p_cantidad, 3);
  assert.ok(Math.abs(new Date(guardado.args.p_llegada) - Date.now()) < 60000, 'no guardó la hora del celular');

  haySenal = true;
  await vuelveLaSenal(page);
  await page.waitForSelector('text=Bienvenidos');
  assert.deepEqual(await cola(page), [], 'quedó algo sin enviar');
  const reintento = llamadas.filter((l) => l.fn === 'expo_registrar_visita').at(-1);
  assert.equal(reintento.args.p_llegada, guardado.args.p_llegada, 'el reintento no mandó la hora en que llegaron');
  await cerrar(page);
});

test(`${ANCHO} px · sin señal: si se cierra la página, al abrirla de nuevo sigue intentando y lo envía`, async () => {
  const guardado = {
    id: 'x1', fn: 'expo_registrar_visita', creado: new Date().toISOString(),
    args: { p_token: TOKEN, p_cantidad: 2, p_llegada: new Date(Date.now() - 600000).toISOString() },
  };
  const { page, llamadas } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN,
    local: { expoCola: [guardado] },
    rpc: { expo_ver_invitado: () => enCurso(), expo_registrar_visita: (a) => registrada(a) },
  });
  await page.waitForSelector('text=Bienvenidos');
  assert.deepEqual(await cola(page), []);
  assert.ok(llamadas.some((l) => l.fn === 'expo_registrar_visita' && l.args.p_llegada === guardado.args.p_llegada));
  await cerrar(page);
});

/* Una acción que se queda sin señal mientras la persona ya cambió de pantalla
   (por ejemplo tocó "¿No es tu empresa?" mientras esperaba): igual se guarda. */
function sinSenalTarde() {
  let soltar;
  const espera = new Promise((ok) => { soltar = ok; });
  return { soltar, responder: async () => { await espera; return SIN_RED; } };
}

test(`${ANCHO} px · sin señal: si cambia de pantalla mientras espera, el registro igual queda guardado`, async () => {
  const tarde = sinSenalTarde();
  const { page } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN,
    rpc: { expo_ver_invitado: (a) => enCurso({}, a.p_token === OTRO_TOKEN ? { razon_social: 'OTRO CLIENTE S.A.' } : {}), expo_registrar_visita: tarde.responder },
  });
  await page.click('#principal');
  await page.evaluate((t) => { location.hash = 't=' + t; }, OTRO_TOKEN);
  await page.waitForSelector('text=OTRO CLIENTE S.A.');
  tarde.soltar();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('expoCola') || '[]').length === 1);
  const [guardado] = await cola(page);
  assert.equal(guardado.fn, 'expo_registrar_visita');
  assert.equal(guardado.args.p_token, TOKEN, 'se guardó para el cliente equivocado');
  assert.match(await texto(page), /OTRO CLIENTE S\.A\./, 'pisó la pantalla del otro cliente');
  await cerrar(page);
});

test(`${ANCHO} px · sin señal: si cambia de pantalla mientras espera, la corrección igual queda guardada`, async () => {
  const tarde = sinSenalTarde();
  const { page } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN,
    rpc: { expo_ver_invitado: () => enCurso({ visita_hoy: { llegada: new Date().toISOString(), cantidad: 2 } }), expo_corregir_cantidad: tarde.responder },
  });
  await page.click('#corregir');
  await page.click('input[value="4"]');
  await page.click('#principal');
  await page.click('#cancelar', { force: true });   // se va de la pantalla mientras espera
  tarde.soltar();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('expoCola') || '[]').length === 1);
  assert.equal((await cola(page))[0].args.p_cantidad, 4);
  await cerrar(page);
});

test(`${ANCHO} px · sin señal: si cambia de pantalla mientras espera, la confirmación igual queda guardada`, async () => {
  const tarde = sinSenalTarde();
  const { page } = await abrir({ ancho: ANCHO, hash: '#t=' + TOKEN, rpc: { expo_ver_invitado: () => previa(), expo_confirmar: tarde.responder } });
  await page.click('#principal');
  await page.evaluate(() => { location.hash = 'buscar'; });
  await page.waitForSelector('text=Escaneá el QR del cartel de la entrada');
  tarde.soltar();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('expoCola') || '[]').length === 1);
  assert.deepEqual((await cola(page))[0].args, { p_token: TOKEN, p_cantidad: 2, p_va: true });
  await cerrar(page);
});

test(`${ANCHO} px · un 404 (la función todavía no está en la base) no tira lo guardado: lo sigue reintentando`, async () => {
  const guardado = {
    id: 'x404', fn: 'expo_registrar_visita', creado: new Date().toISOString(),
    args: { p_token: TOKEN, p_cantidad: 2, p_llegada: new Date(Date.now() - 600000).toISOString() },
  };
  const { page, llamadas } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN, local: { expoCola: [guardado] },
    rpc: { expo_ver_invitado: () => enCurso(), expo_registrar_visita: () => ({ http: 404 }) },
  });
  // la página lo manda sola al abrir: esperar ese intento y que procese la respuesta
  while (!llamadas.some((l) => l.fn === 'expo_registrar_visita')) await new Promise((ok) => setTimeout(ok, 20));
  await page.evaluate(() => new Promise((ok) => setTimeout(ok, 100)));
  assert.equal((await cola(page)).length, 1, 'se descartó un registro por un error de configuración');
  assert.match(await texto(page), /No hay señal, pero ya pueden pasar/);
  await cerrar(page);
});

test(`${ANCHO} px · sin señal al abrir: con lo que se vio antes muestra la razón social; sin nada, deja registrarse igual`, async () => {
  const conCache = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN, local: { ['expoInv:' + TOKEN]: enCurso() },
    rpc: { expo_ver_invitado: () => SIN_RED },
  });
  await conCache.page.waitForSelector('.mr-razon');
  assert.match(await texto(conCache.page), /LIBRERIA PAPELTEC/);
  await cerrar(conCache.page);

  const sinNada = await abrir({ ancho: ANCHO, hash: '#t=' + TOKEN, rpc: { expo_ver_invitado: () => SIN_RED } });
  await sinNada.page.waitForSelector('#principal');
  assert.equal(await sinNada.page.textContent('#principal'), 'Estoy acá · somos 2');
  assert.match(await texto(sinNada.page), /podés registrarte igual/);
  await cerrar(sinNada.page);
});

test(`${ANCHO} px · sin señal con lo guardado de antes de la expo: hoy deja registrarse (no "los esperamos")`, async () => {
  // confirmó desde su casa días antes; hoy es día de expo y en la puerta no hay señal
  const visto = previa({ confirmado: true, confirmado_cantidad: 3 });
  visto.edicion = { ...visto.edicion, dias: [dia(0), dia(1)], hoy: dia(-5) };
  const { page } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN, local: { ['expoInv:' + TOKEN]: visto },
    rpc: { expo_ver_invitado: () => SIN_RED },
  });
  await page.waitForSelector('#principal');
  assert.equal(await page.textContent('#principal'), 'Estoy acá · somos 2');
  assert.doesNotMatch(await texto(page), /Listo, los esperamos/);
  await cerrar(page);
});

test(`${ANCHO} px · sin señal con lo guardado ayer: no dice "ya registrados hoy", ofrece "Volvimos hoy"`, async () => {
  const ayer = enCurso({ visita_hoy: { llegada: new Date(Date.now() - 86400000).toISOString(), cantidad: 3 } });
  ayer.edicion = { ...ayer.edicion, hoy: dia(-1) };
  const { page } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN, local: { ['expoInv:' + TOKEN]: ayer },
    rpc: { expo_ver_invitado: () => SIN_RED },
  });
  await page.waitForSelector('#principal');
  assert.equal(await page.textContent('#principal'), 'Volvimos hoy · somos 2');
  assert.doesNotMatch(await texto(page), /Ya están registrados hoy/);
  await cerrar(page);
});

test(`${ANCHO} px · un registro que sale tarde no pisa la pantalla de otro cliente`, async () => {
  let haySenal = false;
  const { page } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN,
    rpc: {
      expo_ver_invitado: (a) => enCurso({}, a.p_token === OTRO_TOKEN ? { razon_social: 'OTRO CLIENTE S.A.' } : {}),
      expo_registrar_visita: (a) => (haySenal ? registrada(a) : SIN_RED),
    },
  });
  await page.click('#principal');
  await page.waitForSelector('text=No hay señal');
  await page.evaluate((t) => { location.hash = 't=' + t; }, OTRO_TOKEN);
  await page.waitForSelector('text=OTRO CLIENTE S.A.');
  haySenal = true;
  await vuelveLaSenal(page);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('expoCola') || '[]').length === 0);
  assert.doesNotMatch(await texto(page), /Bienvenidos|PAPELTEC/);
  assert.match(await texto(page), /OTRO CLIENTE S\.A\./);
  await cerrar(page);
});

test(`${ANCHO} px · ya vino otro día: lo avisa y el botón dice "Volvimos hoy"`, async () => {
  const { page } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN,
    rpc: { expo_ver_invitado: () => enCurso({ visita_anterior: { dia: dia(-1), cantidad: 3 } }) },
  });
  await page.waitForSelector('#principal');
  assert.match(await page.textContent('.mr-aviso b'), /^Ya vinieron el \S+ \d+$/);
  assert.equal(await page.textContent('.mr-aviso p'), '3 personas. Si hoy volvieron, registralo otra vez.');
  assert.equal(await page.textContent('#principal'), 'Volvimos hoy · somos 2');
  await cerrar(page);
});

test(`${ANCHO} px · antes de la expo: confirmar, cambiar, "No vamos a poder ir" y "Al final sí vamos"`, async () => {
  let estado = previa();
  const { page, llamadas } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN,
    rpc: {
      expo_ver_invitado: () => estado,
      expo_confirmar: (a) => (estado = { ...estado, confirmado: a.p_va, confirmado_cantidad: a.p_va ? a.p_cantidad : null }),
    },
  });
  await page.waitForSelector('#principal');
  assert.equal(await page.textContent('#principal'), 'Confirmo que voy · somos 2');
  assert.equal(await page.textContent('legend'), '¿Cuántos van a venir?');
  assert.deepEqual(await lineas(page, '.mr-cabecera-dato span'), ['Expo 2027', 'Faltan 12 días']);
  assert.equal(await page.textContent('.mr-barra-nota'), 'El mismo QR te sirve para entrar el día de la expo.');
  await page.click('#principal');
  await page.waitForSelector('text=Listo, los esperamos');
  assert.match(await page.innerText('.mr-estado .mr-texto'), /de 10 a 11 h\n2 personas/);

  await page.click('#nova');
  await page.waitForSelector('text=Gracias por avisar');
  assert.deepEqual(llamadas.at(-1).args, { p_token: TOKEN, p_cantidad: null, p_va: false });
  await page.click('#sivamos');
  await page.waitForSelector('text=Confirmo que voy · somos 2');
  await cerrar(page);
});

test(`${ANCHO} px · un "no vamos" que quedó sin enviar no pisa el "sí vamos" de después`, async () => {
  let haySenal = false;
  let enLaBase = previa();
  const { page, llamadas } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN,
    rpc: {
      expo_ver_invitado: () => enLaBase,
      expo_confirmar: (a) => (haySenal ? (enLaBase = { ...enLaBase, confirmado: a.p_va, confirmado_cantidad: a.p_va ? a.p_cantidad : null }) : SIN_RED),
    },
  });
  await page.click('#principal');            // "Confirmo que voy" sin señal: queda en la cola
  await page.waitForSelector('text=Listo, los esperamos');
  await page.click('#nova');                 // "No vamos" sin señal: queda en la cola
  await page.waitForSelector('text=Gracias por avisar');
  haySenal = true;
  await page.click('#sivamos');
  await page.click('#principal');            // "Sí vamos" ya con señal
  await page.waitForSelector('text=Listo, los esperamos');
  await vuelveLaSenal(page);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('expoCola') || '[]').length === 0);
  assert.equal(enLaBase.confirmado, true, 'el "no vamos" viejo pisó la decisión nueva');
  assert.equal(llamadas.filter((l) => l.fn === 'expo_confirmar').at(-1).args.p_va, true);
  await cerrar(page);
});

test(`${ANCHO} px · al reabrir con una confirmación sin enviar, la muestra y la manda`, async () => {
  const guardado = { id: 'c1', fn: 'expo_confirmar', creado: new Date().toISOString(), args: { p_token: TOKEN, p_cantidad: 4, p_va: true } };
  let enLaBase = previa();
  const { page } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN, local: { expoCola: [guardado] },
    rpc: {
      expo_ver_invitado: () => enLaBase,
      expo_confirmar: (a) => (enLaBase = { ...enLaBase, confirmado: a.p_va, confirmado_cantidad: a.p_cantidad }),
    },
  });
  await page.waitForSelector('text=Listo, los esperamos');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('expoCola') || '[]').length === 0);
  assert.equal(enLaBase.confirmado_cantidad, 4);
  assert.match(await texto(page), /4 personas/);
  await cerrar(page);
});

test(`${ANCHO} px · en curso pero hoy no hay expo: dice cuándo sigue y a qué hora abre`, async () => {
  const d = enCurso();
  d.edicion.dias = [dia(-1), dia(1)];
  const { page } = await abrir({ ancho: ANCHO, hash: '#t=' + TOKEN, rpc: { expo_ver_invitado: () => d } });
  await page.waitForSelector('text=La expo sigue el');
  assert.equal(await page.textContent('.mr-estado .mr-chico'), 'Abre a las 9:00.');
  assert.equal(await page.$('#principal'), null);
  await cerrar(page);
});

test(`${ANCHO} px · expo terminada: deriva al vendedor`, async () => {
  const d = { ...enCurso(), estado: 'cerrada', vendedor: 'Juan Pérez' };
  const { page } = await abrir({ ancho: ANCHO, hash: '#t=' + TOKEN, rpc: { expo_ver_invitado: () => d } });
  await page.waitForSelector('text=La expo terminó el');
  assert.match(await texto(page), /hablá con Juan Pérez, tu vendedor/);
  assert.deepEqual(await lineas(page, '.mr-cabecera-dato span'), ['Expo 2026', 'Terminó']);
  await cerrar(page);
});

test(`${ANCHO} px · QR inválido: con la clave del cartel ofrece buscar; sin ella pide escanear el cartel`, async () => {
  const conCartel = await abrir({ ancho: ANCHO, hash: '#t=' + TOKEN, local: { expoCartel: CLAVE_CARTEL }, rpc: { expo_ver_invitado: () => ({ estado: 'invalido' }) } });
  await conCartel.page.waitForSelector('text=No reconocemos este QR');
  assert.equal(await conCartel.page.textContent('.mr-barra .mr-boton'), 'Buscar mi empresa');
  await cerrar(conCartel.page);

  const sinCartel = await abrir({ ancho: ANCHO, hash: '#t=' + TOKEN, rpc: { expo_ver_invitado: () => ({ estado: 'invalido' }) } });
  await sinCartel.page.waitForSelector('text=No reconocemos este QR');
  assert.match(await texto(sinCartel.page), /Escaneá el QR del cartel de la entrada/);
  await cerrar(sinCartel.page);
});

test(`${ANCHO} px · un token mal formado ni se manda a la base`, async () => {
  const { page, llamadas } = await abrir({ ancho: ANCHO, hash: '#t=' + encodeURIComponent("x' or 1=1--") });
  await page.waitForSelector('text=No reconocemos este QR');
  assert.deepEqual(llamadas, []);
  await cerrar(page);
});

test(`${ANCHO} px · nunca acepta un #access_token pegado en la URL`, async () => {
  const { page, llamadas } = await abrir({ ancho: ANCHO, hash: '#access_token=eyJfalso&refresh_token=r1&t=' + TOKEN, rpc: { expo_ver_invitado: () => enCurso() } });
  await page.waitForSelector('#app main');
  assert.doesNotMatch(await page.evaluate(() => location.href), /access_token|refresh_token|eyJfalso/);
  assert.deepEqual(llamadas, [], 'usó la URL con el token de sesión');
  const guardado = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  assert.doesNotMatch(guardado, /eyJfalso/);
  await cerrar(page);
});

test(`${ANCHO} px · los nombres que vienen de la base se muestran como texto, nunca como HTML`, async () => {
  const malo = '<img src=x onerror="window.__xss=1">ACME <script>window.__xss=2</script> & "CIA"';
  const { page } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN,
    rpc: {
      expo_ver_invitado: () => enCurso({ nombre_credencial: malo }, { razon_social: malo + ' - ' + malo, localidad: malo, codigo_erp: '<b>1</b>' }),
      expo_registrar_visita: (a) => registrada(a, { razon_social: malo, nombre_credencial: malo }),
    },
  });
  await page.waitForSelector('.mr-razon');
  assert.equal(await page.$('#app img:not(.mr-logo img), #app script, #app b:has-text("1")'), null, 'se interpretó HTML');
  assert.match(await page.textContent('.mr-razon'), /<img src=x onerror=/);
  await page.click('#principal');
  await page.waitForSelector('text=Bienvenidos');
  assert.equal(await page.$('#app img:not(.mr-logo img), #app script'), null, 'se interpretó HTML al registrar');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await cerrar(page);
});

test(`${ANCHO} px · expo terminada con un vendedor raro: también escapado`, async () => {
  const d = { ...enCurso(), estado: 'cerrada', vendedor: '<img src=x onerror="window.__xss=3">' };
  const { page } = await abrir({ ancho: ANCHO, hash: '#t=' + TOKEN, rpc: { expo_ver_invitado: () => d } });
  await page.waitForSelector('text=La expo terminó el');
  assert.equal(await page.$('#app img:not(.mr-logo img)'), null);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await cerrar(page);
});

test(`${ANCHO} px · modo oscuro: data-theme sigue al celular y cambia de logo`, async () => {
  const { page } = await abrir({ ancho: ANCHO, oscuro: true, hash: '#t=' + TOKEN, rpc: { expo_ver_invitado: () => enCurso() } });
  await page.waitForSelector('.mr-razon');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  assert.equal(await page.isVisible('.mr-logo-oscuro'), true);
  assert.equal(await page.isVisible('.mr-logo-claro'), false);
  await cerrar(page);
});

test(`${ANCHO} px · con el almacenamiento lleno, sin señal igual deja pasar y lo manda cuando vuelve`, async () => {
  let haySenal = false;
  const { page, llamadas, errores } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN, almacenamiento: 'lleno',
    rpc: { expo_ver_invitado: () => (haySenal ? enCurso() : SIN_RED), expo_registrar_visita: (a) => (haySenal ? registrada(a) : SIN_RED) },
  });
  await page.click('#principal');
  await page.waitForSelector('text=No hay señal, pero ya pueden pasar');
  haySenal = true;
  await vuelveLaSenal(page);
  await page.waitForSelector('text=Bienvenidos');
  assert.equal(llamadas.filter((l) => l.fn === 'expo_registrar_visita').at(-1).args.p_cantidad, 2);
  assert.deepEqual(errores, []);
  await cerrar(page);
});

test(`${ANCHO} px · con el almacenamiento lleno, una confirmación sin señal sale cuando vuelve`, async () => {
  let haySenal = false;
  const { page, llamadas } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN, almacenamiento: 'lleno',
    rpc: { expo_ver_invitado: () => previa(), expo_confirmar: (a) => (haySenal ? previa({ confirmado: true, confirmado_cantidad: a.p_cantidad }) : SIN_RED) },
  });
  await page.click('#principal');
  await page.waitForSelector('text=Reintentando enviar');
  const intentos = llamadas.filter((l) => l.fn === 'expo_confirmar').length;
  haySenal = true;
  await vuelveLaSenal(page);
  await page.waitForFunction(() => !document.querySelector('#app').textContent.includes('Reintentando'));
  assert.ok(llamadas.filter((l) => l.fn === 'expo_confirmar').length > intentos, 'no la volvió a mandar');
  await cerrar(page);
});

test(`${ANCHO} px · registrado con señal (o por la cola), al reabrir sin señal ya figura registrado con esa cantidad`, async () => {
  for (const [token, conSenalAlRegistrar] of [[TOKEN, true], [OTRO_TOKEN, false]]) {
    let haySenal = true;
    const { page } = await abrir({
      ancho: ANCHO, hash: '#t=' + token,
      rpc: {
        expo_ver_invitado: () => (haySenal ? enCurso() : SIN_RED),
        expo_registrar_visita: (a) => (haySenal ? registrada(a) : SIN_RED),
      },
    });
    await page.waitForSelector('#principal');
    await page.click('input[value="3"]');
    if (!conSenalAlRegistrar) haySenal = false;
    await page.click('#principal');
    if (!conSenalAlRegistrar) {
      await page.waitForSelector('text=No hay señal, pero ya pueden pasar');
      haySenal = true;
      await vuelveLaSenal(page);
    }
    await page.waitForSelector('text=Bienvenidos');
    haySenal = false;   // adentro de la expo, sin señal, vuelve a abrir el link
    await page.reload();
    await page.waitForSelector('text=Ya están registrados hoy');
    assert.match(await texto(page), /3 personas/, conSenalAlRegistrar ? 'directo' : 'por la cola');
    assert.equal(await page.$('input[type=radio]'), null, 'ofrece registrarse otra vez: la cantidad nueva se perdería');
    await cerrar(page);
  }
});

test(`${ANCHO} px · una corrección vieja que la cola ya mandó llega antes que la nueva (no la pisa)`, async () => {
  const llegada = new Date(Date.now() - 600000).toISOString();
  const vieja = { id: 'vieja', fn: 'expo_corregir_cantidad', creado: llegada, args: { p_token: TOKEN, p_cantidad: 3 } };
  let soltar;
  const demorada = new Promise((ok) => { soltar = ok; });
  const aplicadas = [];
  const { page } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN, local: { expoCola: [vieja] },
    rpc: {
      expo_ver_invitado: () => enCurso({ visita_hoy: { llegada, cantidad: 2 } }),
      expo_corregir_cantidad: async (a) => {
        if (a.p_cantidad === 3) await demorada;   // la red la demora
        aplicadas.push(a.p_cantidad);
        return { dia: hoy(), llegada, cantidad: a.p_cantidad };
      },
    },
  });
  await page.waitForRequest((r) => r.url().endsWith('/rpc/expo_corregir_cantidad'));   // la vieja, en camino
  await page.click('#corregir');
  await page.click('input[value="4"]');
  await page.click('#principal');
  await page.waitForTimeout(300);
  soltar();
  await page.waitForSelector('text=4 personas');
  assert.deepEqual(aplicadas, [3, 4], 'la vieja llegó después y pisó la nueva');
  await cerrar(page);
});

test(`${ANCHO} px · un "no vamos" que la cola ya mandó llega antes que el "sí vamos" de después (no lo pisa)`, async () => {
  const novamos = { id: 'novamos', fn: 'expo_confirmar', creado: new Date().toISOString(), args: { p_token: TOKEN, p_cantidad: null, p_va: false } };
  let soltar;
  const demorado = new Promise((ok) => { soltar = ok; });
  const aplicadas = [];
  const { page } = await abrir({
    ancho: ANCHO, hash: '#t=' + TOKEN, local: { expoCola: [novamos] },
    rpc: {
      expo_ver_invitado: () => previa(),
      expo_confirmar: async (a) => {
        if (!a.p_va) await demorado;   // la red lo demora
        aplicadas.push(a.p_va);
        return previa({ confirmado: a.p_va, confirmado_cantidad: a.p_cantidad });
      },
    },
  });
  await page.waitForRequest((r) => r.url().endsWith('/rpc/expo_confirmar'));   // el "no vamos", en camino
  await page.click('#sivamos');
  await page.click('#principal');
  await page.waitForTimeout(300);
  soltar();
  await page.waitForSelector('text=Listo, los esperamos');
  assert.deepEqual(aplicadas, [false, true], 'el "no vamos" llegó después y pisó el "sí vamos"');
  await cerrar(page);
});
