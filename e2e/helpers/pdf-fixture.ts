/** A small, valid PDF with real text, two pages, and a link annotation. No PDF engine is mocked. */
export function pdfFixture(firstPageTitle = 'Quarterly revenue review'): Buffer {
  const escapedTitle = firstPageTitle.replace(/[\\()]/g, '\\$&')
  const streams = [
    `BT /F1 18 Tf 72 720 Td (${escapedTitle}) Tj 0 -30 Td (Select this sentence for feedback.) Tj ET`,
    'BT /F1 18 Tf 72 720 Td (Forecast and next steps) Tj 0 -30 Td (This is the second page.) Tj ET',
  ]
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /Annots [8 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...streams.map(stream => `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`),
    '<< /Type /Annot /Subtype /Link /Rect [72 650 270 675] /Border [0 0 0] /A << /S /URI /URI (https://example.com/pdf-reference) >> >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const startXref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`
  return Buffer.from(pdf)
}
