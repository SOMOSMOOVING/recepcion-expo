// La razón social nunca se corta, a ningún ancho de celular (320 a 412 px),
// y nada de la pantalla se sale por el costado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrir, ANCHOS, TOKEN, CLAVE_CARTEL, enCurso, desbordes } from './navegador.mjs';

const RAZONES = {
  'con guion': 'MINUCHIN MARTA LILIANA - LIBRERIA PAPELTEC',
  'más de 60 caracteres': 'COOPERATIVA DE TRABAJO ESCOLAR NUESTRA SEÑORA DE LUJAN LIMITADA - LIBRERIA LA COOPE',
  'una palabra larguísima': 'DISTRIBUIDORAESCOLARDELOESTEYDELNORTEYDELSUR S.R.L.',
};

// ¿Se ve entera? Ni puntos suspensivos, ni recorte, ni nada afuera de la pantalla.
function medirRazon(page) {
  return page.evaluate(() => {
    const h1 = document.querySelector('.mr-razon');
    const css = getComputedStyle(h1);
    const r = h1.getBoundingClientRect();
    return {
      texto: [...h1.querySelectorAll('span')].map((s) => s.textContent),
      cortaConPuntos: css.textOverflow === 'ellipsis' || css.webkitLineClamp !== 'none',
      ocultaLoQueSobra: css.overflow !== 'visible' && (h1.scrollWidth > h1.clientWidth || h1.scrollHeight > h1.clientHeight),
      adentro: r.left >= 0 && r.right <= document.documentElement.clientWidth,
      larga: h1.classList.contains('mr-razon--larga'),
    };
  });
}

for (const ancho of ANCHOS) {
  for (const [caso, razonSocial] of Object.entries(RAZONES)) {
    test(`${ancho} px · check-in · razón social ${caso}: entera y sin salirse`, async () => {
      const { page, errores } = await abrir({
        ancho, hash: '#t=' + TOKEN,
        rpc: { expo_ver_invitado: () => enCurso({}, { razon_social: razonSocial }) },
      });
      await page.waitForSelector('.mr-razon');
      const m = await medirRazon(page);
      const i = razonSocial.indexOf(' - ');
      assert.deepEqual(m.texto, i > 0 ? [razonSocial.slice(0, i), razonSocial.slice(i + 3)] : [razonSocial],
        'no se partió en el primer " - " o le falta texto');
      assert.equal(m.cortaConPuntos, false, 'tiene puntos suspensivos');
      assert.equal(m.ocultaLoQueSobra, false, 'esconde lo que no entra');
      assert.equal(m.adentro, true, 'se sale de la pantalla');
      assert.equal(m.larga, razonSocial.length > 60, 'más de 60 caracteres tiene que bajar a 24 px');
      assert.deepEqual(await desbordes(page), []);
      assert.deepEqual(errores, []);
      await page.context().close();
    });
  }

  test(`${ancho} px · check-in · los seis botones del contador y el botón principal entran`, async () => {
    const { page } = await abrir({ ancho, hash: '#t=' + TOKEN, rpc: { expo_ver_invitado: () => enCurso() } });
    await page.waitForSelector('.mr-contador');
    await page.click('[aria-label="6 o más"]');  // el radio transparente va encima del "6+"
    await page.click('[aria-label="Uno más"]');
    assert.equal(await page.textContent('#principal'), 'Estoy acá · somos 7');
    assert.deepEqual(await desbordes(page), []);
    await page.context().close();
  });

  test(`${ancho} px · cartel · resultados y alta rápida sin salirse`, async () => {
    const { page } = await abrir({
      ancho, hash: '#cartel=' + CLAVE_CARTEL,
      rpc: {
        expo_buscar: () => [
          { token: 'b'.repeat(32), razon_social: RAZONES['más de 60 caracteres'], localidad: 'Bernardo de Irigoyen', codigo_erp: '14420' },
          { token: 'c'.repeat(32), razon_social: RAZONES['una palabra larguísima'], localidad: 'Ituzaingó', codigo_erp: '10388' },
        ],
      },
    });
    await page.fill('#q', 'libreria');
    await page.waitForSelector('.mr-resultado');
    assert.deepEqual(await desbordes(page), [], 'resultados');
    await page.click('text=Registrarme sin estar en la lista');
    await page.waitForSelector('#nombre');
    assert.deepEqual(await desbordes(page), [], 'alta rápida');
    await page.context().close();
  });
}
