import * as library from './assets/pdf-lib.min.js';
import * as fontkitLibrary from './assets/fontkit.min.js';

const PAGE_SIZE = [595.28, 841.89];
const MARGIN = 43;
const TEXT_WIDTH = PAGE_SIZE[0] - MARGIN * 2;
const ROW_BREAK = /\r\n|[\n\r\f\v\u0085\u2028\u2029]/u;

async function localAsset(name) {
  const response = await fetch(new URL('./assets/' + name, import.meta.url));
  if (!response.ok) throw new Error('Recurso do PDF indisponível.');
  return response.arrayBuffer();
}

function* wrapRow(text, font, size) {
  let line = '';
  for (const word of text.match(/[^ ]+ *| +/gu) ?? []) {
    if (line && font.widthOfTextAtSize(line + word, size) > TEXT_WIDTH) {
      yield line;
      line = '';
    }
    // Very long references can run across multiple lines within the page.
    if (font.widthOfTextAtSize(word, size) > TEXT_WIDTH) {
      for (const character of word) {
        if (line && font.widthOfTextAtSize(line + character, size) > TEXT_WIDTH) {
          yield line;
          line = '';
        }
        line += character;
      }
    } else {
      line += word;
    }
  }
  yield line;
}

export async function packingPDF(title, text, { logo, fonts } = {}) {
  const { PDFDocument, rgb } = globalThis.PDFLib ?? library.default;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(globalThis.fontkit ?? fontkitLibrary.default);
  const [logoBytes, fontBytes] = await Promise.all([
    logo ?? localAsset('granitrans-logo.png'),
    fonts ?? Promise.all([localAsset('NotoSans-Regular.ttf'), localAsset('NotoSans-Bold.ttf')]),
  ]);
  const options = { subset: true, features: { liga: false, clig: false } };
  const [regular, bold] = await Promise.all(fontBytes.map((bytes) => pdf.embedFont(bytes, options)));
  const mark = await pdf.embedPng(logoBytes);
  const regularGlyphs = new Set(regular.getCharacterSet());
  const boldGlyphs = new Set(bold.getCharacterSet());

  let page;
  let y;
  function addPage(first) {
    page = pdf.addPage(PAGE_SIZE);
    y = PAGE_SIZE[1] - MARGIN - 11;
    if (first) {
      const dimensions = mark.scaleToFit(180, 44);
      page.drawImage(mark, { ...dimensions, x: MARGIN, y: y - dimensions.height });
      y -= dimensions.height + 30;
    }
  }
  function drawRow(value, font, fontSize) {
    const row = value.normalize('NFC').replaceAll('\t', '    ');
    const glyphs = font === bold ? boldGlyphs : regularGlyphs;
    for (const character of row) {
      if (!glyphs.has(character.codePointAt(0))) throw new RangeError('O texto contém um carácter sem representação no PDF.');
    }
    for (const line of wrapRow(row, font, fontSize)) {
      if (line.trim()) {
        if (y < MARGIN + fontSize) addPage(false);
        page.drawText(line, { font, size: fontSize, x: MARGIN, y, color: rgb(0, 0, 0) });
      }
      y -= fontSize + 5;
    }
  }

  addPage(true);
  for (const line of title.split(ROW_BREAK)) drawRow(line, bold, 16);
  y -= 7;
  for (const row of text.split(ROW_BREAK)) {
    drawRow(row, /^(?:Para |Pour |-)[^:]+:$/u.test(row) ? bold : regular, 10);
  }
  pdf.setTitle(title.normalize('NFC'));
  return pdf.save();
}
