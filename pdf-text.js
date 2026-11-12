// pdf-text.js — pull text out of a PDF, keeping where each piece sits on the page.
//
// Returns one entry per page:
//   { page, width, height, items: [ { text, x, y, width, fontName } ], lines: [ { x0, x1, y } ] }
// `lines` are the horizontal lines drawn on the page (used to spot the double line on swing runs).
// x and y are in PDF points measured from the TOP-LEFT corner (y grows downward).

import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * @param {Uint8Array} data  the PDF file's bytes
 * @param {(done:number,total:number)=>void} [onProgress]
 */
export async function readPdfPages(data, onProgress) {
  const task = getDocument({ data, verbosity: 0, isEvalSupported: false });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { width, height } = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = [];
      for (const it of content.items) {
        if (!it.str || !it.str.trim()) continue;
        items.push({
          text: it.str,
          x: it.transform[4],
          y: height - it.transform[5],
          width: it.width,
          fontName: it.fontName,
        });
      }
      const lines = horizontalLines(await page.getOperatorList(), height);
      pages.push({ page: n, width, height, items, lines });
      page.cleanup();
      onProgress?.(n, doc.numPages);
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

/** Horizontal lines drawn on a page, in points from the top-left. Thin filled bars count too. */
function horizontalLines(opList, pageHeight) {
  const mul = (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const lines = [];
  opList.fnArray.forEach((fn, i) => {
    const args = opList.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.constructPath) {
      const box = args.at(-1);
      if (!box || box.length < 4) return;
      const pt = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
      const [ax, ay] = pt(box[0], box[1]);
      const [bx, by] = pt(box[2], box[3]);
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
      const yTop = pageHeight - Math.max(ay, by), yBottom = pageHeight - Math.min(ay, by);
      if (x1 - x0 > 40 && yBottom - yTop < 2) lines.push({ x0, x1, y: (yTop + yBottom) / 2 });
    }
  });
  // A stroked line and the thin bar drawn under it show up twice: keep one.
  lines.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  return lines.filter((l, k) => !lines.slice(0, k).some((m) => Math.abs(m.y - l.y) < 1 && Math.abs(m.x0 - l.x0) < 5));
}
