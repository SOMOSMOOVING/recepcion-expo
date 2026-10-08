// Pantalla 2 · cartel de la entrada: buscador y alta rápida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrir, cola, vuelveLaSenal, respuestaDe, pideEnUnSegundo, CLAVE_CARTEL, SIN_RED } from './navegador.mjs';

const ANCHO = 390;   // el ancho de estos tests; los demás anchos están en anchos.test.mjs
const PAPELTEC = { token: 'b'.repeat(32), razon_social: 'MINUCHIN MARTA LILIANA - LIBRERIA PAPELTEC', localidad: 'Lanús', codigo_erp: '10234' };
const texto = (page) => page.textContent('#app');
const cerrar = (page) => page.context().close();
const altaLista = (a) => ({ nueva: true, token: 'd'.repeat(32), razon_social: a.p_empresa, llegada: new Date().toISOString(), cantidad: a.p_cantidad });

test(`${ANCHO} px · el QR del cartel guarda la clave en el celular y la saca de la URL`, async () => {
  const { page } = await abrir({ ancho: ANCHO, hash: '#cartel=' + CLAVE_CARTEL });
  await page.waitForSelector('text=Buscá tu empresa');
  assert.equal(await page.evaluate(() => location.hash), '#buscar');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('expoCartel'))), CLAVE_CARTEL);
  await cerrar(page);
});

test(`${ANCHO} px · con menos de 3 letras no busca; con 3 o más manda la clave del cartel`, async () => {
  const { page, llamadas } = await abrir({ ancho: ANCHO, hash: '#cartel=' + CLAVE_CARTEL, rpc: { expo_buscar: () => [PAPELTEC] } });
  const pedido = pideEnUnSegundo(page, 'expo_buscar');
  await page.fill('#q', 'pa');
  assert.equal(await pedido, null, 'buscó con 2 letras');
  assert.deepEqual(llamadas, []);
  assert.match(await texto(page), /Escribí al menos 3 letras/);
  await page.fill('#q', 'papel');
  await page.waitForSelector('.mr-resultado');
  assert.deepEqual(llamadas.at(-1), { fn: 'expo_buscar', args: { p_clave: CLAVE_CARTEL, p_texto: 'papel' } });
  await cerrar(page);
});

test(`${ANCHO} px · una búsqueda vieja que contesta tarde no pisa la nueva`, async () => {
  let soltarVieja;
  const vieja = new Promise((ok) => { soltarVieja = ok; });
  const { page } = await abrir({
    ancho: ANCHO, hash: '#cartel=' + CLAVE_CARTEL,
    rpc: {
      expo_buscar: async (a) => {
        if (a.p_texto === 'pap') { await vieja; return [{ ...PAPELTEC, razon_social: 'VIEJA S.A.' }]; }
        return [PAPELTEC];
      },
    },
  });
  const pidioLaVieja = page.waitForRequest((r) => r.url().endsWith('/rpc/expo_buscar') && r.postData().includes('"pap"'));
  await page.fill('#q', 'pap');
  await pidioLaVieja;
  await page.fill('#q', 'papel');
  await page.waitForSelector('text=1 resultado');
  const llegoLaVieja = respuestaDe(page, 'expo_buscar', (a) => a.p_texto === 'pap');
  soltarVieja();
  await llegoLaVieja;
  assert.doesNotMatch(await texto(page), /VIEJA S\.A\./);
  assert.match(await texto(page), /PAPELTEC/);
  await cerrar(page);
});

test(`${ANCHO} px · resultados: resalta lo buscado, cuenta y abre la pantalla del cliente`, async () => {
  const { page } = await abrir({ ancho: ANCHO, hash: '#cartel=' + CLAVE_CARTEL, rpc: { expo_buscar: () => [PAPELTEC] } });
  await page.fill('#q', 'Papel');
  await page.waitForSelector('.mr-resultado');
  assert.equal(await page.textContent('mark.mr-encontrado'), 'PAPEL');
  assert.match(await texto(page), /1 resultado/);
  assert.match(await texto(page), /Lanús · Cód\. 10234/);
  await page.click('.mr-resultado');
  assert.equal(await page.evaluate(() => location.hash), '#t=' + PAPELTEC.token);
  await cerrar(page);
});

test(`${ANCHO} px · resultados con nombres raros: escapados, y el resaltado no rompe nada`, async () => {
  const malo = { ...PAPELTEC, razon_social: '<img src=x onerror="window.__xss=1">PAPELERA <b>X</b>', localidad: '<script>window.__xss=2</script>' };
  const { page } = await abrir({ ancho: ANCHO, hash: '#cartel=' + CLAVE_CARTEL, rpc: { expo_buscar: () => [malo] } });
  await page.fill('#q', 'papel');
  await page.waitForSelector('.mr-resultado');
  assert.equal(await page.$('#app img:not(.mr-logo img), #app script, .mr-resultado b'), null, 'se interpretó HTML');
  assert.match(await page.textContent('.mr-resultado-razon'), /<img src=x/);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await cerrar(page);
});

test(`${ANCHO} px · un resultado con token raro no se muestra (no se puede tocar)`, async () => {
  const { page } = await abrir({
    ancho: ANCHO, hash: '#cartel=' + CLAVE_CARTEL,
    rpc: { expo_buscar: () => [{ ...PAPELTEC, token: '"><img src=x onerror="window.__xss=1">' }] },
  });
  await page.fill('#q', 'papel');
  await page.waitForSelector('text=No encontramos');
  assert.equal(await page.$('.mr-resultado'), null);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await cerrar(page);
});

test(`${ANCHO} px · sin resultados: "Registrarme igual" lleva al alta con la empresa ya escrita`, async () => {
  const { page } = await abrir({ ancho: ANCHO, hash: '#cartel=' + CLAVE_CARTEL, rpc: { expo_buscar: () => [] } });
  await page.fill('#q', 'kalu marroquinería');
  await page.waitForSelector('text=No encontramos “kalu marroquinería”');
  await page.click('text=Registrarme igual');
  await page.waitForSelector('#nombre');
  assert.equal(await page.inputValue('#empresa'), 'kalu marroquinería');
  await cerrar(page);
});

test(`${ANCHO} px · error de búsqueda: dice qué hacer y "Probar de nuevo" vuelve a buscar`, async () => {
  let haySenal = false;
  const { page } = await abrir({ ancho: ANCHO, hash: '#cartel=' + CLAVE_CARTEL, rpc: { expo_buscar: () => (haySenal ? [PAPELTEC] : SIN_RED) } });
  await page.fill('#q', 'papel');
  await page.waitForSelector('text=No pudimos buscar');
  assert.match(await texto(page), /Revisá la señal o conectate al wifi de la expo/);
  haySenal = true;
  await page.click('#denuevo');
  await page.waitForSelector('.mr-resultado');
  await cerrar(page);
});

test(`${ANCHO} px · si la clave del cartel dejó de valer, la borra y pide escanear de nuevo`, async () => {
  const { page } = await abrir({ ancho: ANCHO, hash: '#cartel=' + CLAVE_CARTEL, rpc: { expo_buscar: () => ({ error: 'expo_clave_cartel_invalida' }) } });
  await page.fill('#q', 'papel');
  await page.waitForSelector('text=Escaneá el QR del cartel de la entrada');
  assert.equal(await page.evaluate(() => localStorage.getItem('expoCartel')), null);
  await cerrar(page);
});

test(`${ANCHO} px · sin la clave del cartel no hay buscador`, async () => {
  const { page, llamadas } = await abrir({ ancho: ANCHO, hash: '#buscar' });
  await page.waitForSelector('text=Escaneá el QR del cartel de la entrada');
  assert.equal(await page.$('#q'), null);
  assert.deepEqual(llamadas, []);
  await cerrar(page);
});

test(`${ANCHO} px · alta rápida: pide nombre y empresa, y manda categoría, cantidad y una clave para no duplicar`, async () => {
  const { page, llamadas } = await abrir({ ancho: ANCHO, hash: '#cartel=' + CLAVE_CARTEL, rpc: { expo_alta_rapida: altaLista } });
  await page.click('text=Registrarme sin estar en la lista');
  await page.waitForSelector('#nombre');
  await page.click('#principal');
  assert.match(await texto(page), /Falta tu nombre y la empresa o el comercio/);
  assert.equal(await page.getAttribute('#nombre', 'aria-invalid'), 'true');
  assert.deepEqual(llamadas, []);

  await page.fill('#nombre', '  Silvina   Fernández ');
  await page.fill('#empresa', 'Marroquinería Kalu');
  await page.click('text=Soy proveedor');
  await page.click('input[value="1"]');
  assert.equal(await page.textContent('#principal'), 'Registrarme · vengo solo');
  await page.click('#principal');
  await page.waitForSelector('text=Bienvenidos');
  assert.match(await texto(page), /Marroquinería Kalu/);
  const { args } = llamadas.at(-1);
  assert.equal(args.p_clave_cartel, CLAVE_CARTEL);
  assert.equal(args.p_nombre, 'Silvina Fernández');
  assert.equal(args.p_categoria, 'proveedor');
  assert.equal(args.p_cantidad, 1);
  assert.equal(args.p_cuit, null);
  assert.match(args.p_clave, /^[0-9a-f-]{36}$/);
  await cerrar(page);
});

test(`${ANCHO} px · alta rápida que la base rechaza (tope del día): lo dice y deja reintentar`, async () => {
  const { page } = await abrir({ ancho: ANCHO, hash: '#alta', local: { expoCartel: CLAVE_CARTEL }, rpc: { expo_alta_rapida: () => ({ error: 'expo_demasiadas_altas_dia' }) } });
  await page.fill('#nombre', 'Silvina');
  await page.fill('#empresa', 'Kalu');
  await page.click('#principal');
  await page.waitForSelector('text=Se llegó al máximo de registros de hoy');
  assert.equal(await page.isDisabled('#principal'), false);
  await cerrar(page);
});

test(`${ANCHO} px · alta rápida que vuelve a la señal justo con el tope por minuto: se reintenta, no se pierde`, async () => {
  let respuesta = SIN_RED;
  const { page, llamadas } = await abrir({
    ancho: ANCHO, hash: '#alta', local: { expoCartel: CLAVE_CARTEL },
    rpc: { expo_alta_rapida: (a) => (typeof respuesta === 'function' ? respuesta(a) : respuesta) },
  });
  await page.fill('#nombre', 'Silvina');
  await page.fill('#empresa', 'Kalu');
  await page.click('#principal');
  await page.waitForSelector('text=No hay señal, pero ya pueden pasar');
  respuesta = { error: 'expo_demasiadas_altas_minuto' };   // vuelve la señal, pero la base pide esperar
  const frenada = respuestaDe(page, 'expo_alta_rapida');
  await vuelveLaSenal(page);
  await frenada;
  assert.equal((await cola(page)).length, 1, 'el alta se descartó: la persona entró y no quedó registro');
  respuesta = altaLista;
  await vuelveLaSenal(page);
  await page.waitForSelector('text=Bienvenidos');
  assert.deepEqual(await cola(page), []);
  await cerrar(page);
});

test(`${ANCHO} px · alta rápida sin señal: deja pasar, guarda y la reintenta con la misma clave`, async () => {
  let haySenal = false;
  const { page, llamadas } = await abrir({
    ancho: ANCHO, hash: '#alta', local: { expoCartel: CLAVE_CARTEL },
    rpc: { expo_alta_rapida: (a) => (haySenal ? altaLista(a) : SIN_RED) },
  });
  await page.fill('#nombre', 'Silvina');
  await page.fill('#empresa', '<i>Kalu</i>');
  await page.click('#principal');
  await page.waitForSelector('text=No hay señal, pero ya pueden pasar');
  assert.equal(await page.$('#app i'), null, 'la empresa escrita se interpretó como HTML');
  const [guardada] = await cola(page);
  haySenal = true;
  await vuelveLaSenal(page);
  await page.waitForSelector('text=Bienvenidos');
  assert.equal(llamadas.at(-1).args.p_clave, guardada.args.p_clave, 'el reintento cambió la clave: duplicaría el alta');
  assert.deepEqual(await cola(page), []);
  await cerrar(page);
});
