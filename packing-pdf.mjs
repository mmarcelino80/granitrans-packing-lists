import * as library from './assets/pdf-lib.min.js';

export async function packingPDF(title, text, { logo } = {}) {
  const { PDFDocument, StandardFonts, rgb } = globalThis.PDFLib ?? library.default;
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  logo ??= await (await fetch(new URL('./assets/granitrans-logo.png', import.meta.url))).arrayBuffer();
  const mark = await pdf.embedPng(logo);
  let page;
  let y;
  const size = [595.28, 841.89];
  const line = (value, font, fontSize) => {
    if (y < 52) addPage(false);
    page.drawText(value, { font, size: fontSize, x: 43, y, color: rgb(0, 0, 0) });
    y -= fontSize + 5;
  };
  function addPage(first) {
    page = pdf.addPage(size);
    y = 790;
    if (first) {
      const dimensions = mark.scaleToFit(180, 44);
      page.drawImage(mark, { ...dimensions, x: 43, y: y - dimensions.height });
      y -= dimensions.height + 30;
    }
  }
  function paragraph(value, font, fontSize) {
    let segment = '';
    for (const character of value.replaceAll('\t', '    ')) {
      if (segment && font.widthOfTextAtSize(segment + character, fontSize) > size[0] - 86) {
        line(segment, font, fontSize);
        segment = '';
      }
      segment += character;
    }
    line(segment, font, fontSize);
  }
  addPage(true);
  paragraph(title, bold, 16);
  y -= 7;
  for (const row of text.split(/\r?\n/)) {
    paragraph(row, /^(?:Para |Pour |-)[^:]+:$/u.test(row) ? bold : regular, 10);
  }
  pdf.setTitle(title);
  return pdf.save();
}
