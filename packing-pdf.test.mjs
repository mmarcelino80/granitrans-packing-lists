import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import PDFLib from './assets/pdf-lib.min.js';
import { packingPDF } from './packing-pdf.mjs';

const assets = (name) => readFile(new URL('./assets/' + name, import.meta.url));
const [logo, regular, bold] = await Promise.all([
  assets('granitrans-logo.png'), assets('NotoSans-Regular.ttf'), assets('NotoSans-Bold.ttf'),
]);
const toPDF = (title, body) => packingPDF(title, body, { logo, fonts: [regular, bold] });
const fixture = [
  'Para Loulé:',
  'Portugal: ação, São João, lâmina, ângulo, cão, órgão, poço, Luís, avô e avó.',
  'España: señor, Nº 23, ¿acabado satinado? ¡Sí! ¡Envío rápido a A Coruña!',
  'Pour Paris :',
  'France: œuvre, Œuvre, Élaminé, quatrième, façonné, Noël, où, forêt et dimensions : 5 m².',
  'Français et Portugais: CŒUR, goût, À, Ê, Û, È, élève, née et coeur.',
];
const normalized = (value) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();

function extract(t, pdf, flag) {
  const conversion = spawnSync('pdftotext', [flag, '-', '-'], { input: pdf, encoding: 'utf8' });
  if (conversion.error?.code === 'ENOENT') {
    t.skip('Poppler (pdftotext) is unavailable for the extracted-text assertion.');
    return undefined;
  }
  assert.equal(conversion.status, 0, conversion.stderr);
  return conversion.stdout;
}

test('multilingual PDF contains valid Portuguese, Spanish and French accents and punctuation', async (t) => {
  const title = 'PACKING LIST – Déchargement à La Coruña';
  const pdf = await toPDF(title, fixture.join('\r\n'));
  const document = await PDFLib.PDFDocument.load(pdf);
  assert.equal(document.getTitle(), title);
  assert.equal(document.getPageCount(), 1);
  const output = extract(t, pdf, '-layout');
  if (output === undefined) return;
  assert.equal(normalized(output), normalized([title, ...fixture].join(' ')));
});

test('long multilingual paragraphs wrap on A4 without clipping or losing rows across pages', async (t) => {
  const title = 'PACKING LIST – Descarga em Loulé';
  const identifier = 'RÉF-ÓÉÑÀŒ'.repeat(66);
  const body = Array.from({ length: 108 }, (_, index) => [
    `LINHA-${String(index + 1).padStart(3, '0')} – ${fixture[1]} ${fixture[2]} ${fixture[4]}`,
    ...(index === 0 ? ['', identifier] : []),
  ]).flat();
  const pdf = await toPDF(title, body.join('\r'));
  const document = await PDFLib.PDFDocument.load(pdf);
  assert.ok(document.getPageCount() >= 6);
  for (const page of document.getPages()) assert.deepEqual(page.getSize(), { width: 595.28, height: 841.89 });

  const output = extract(t, pdf, '-raw');
  if (output === undefined) return;
  const withoutSpaces = (value) => value.normalize('NFC').replace(/\s+/gu, '');
  assert.equal(withoutSpaces(output), withoutSpaces([title, ...body].join(' ')));
  assert.deepEqual(output.match(/LINHA-\d{3}/gu), body.flatMap((line) => line.match(/LINHA-\d{3}/gu) ?? []));

  const bounds = extract(t, pdf, '-bbox');
  const words = [...bounds.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">/gu)];
  assert.ok(words.length > 100);
  for (const [, left, top, right, bottom] of words) {
    assert.ok(Number(left) >= 42 && Number(right) <= 553.28, `Text exceeded the horizontal margins: ${left}–${right}`);
    assert.ok(Number(top) >= 42 && Number(bottom) <= 799.89, `Text exceeded the vertical margins: ${top}–${bottom}`);
  }
});
