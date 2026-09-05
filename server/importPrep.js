const path = require('path');
const ExcelJS = require('exceljs');
const {
  createBatch,
  finishBatch,
  ensureOffice,
  upsertAssignedLine,
} = require('./db');
const { normalizePhone } = require('./phone');

function excelSerialToIso(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n < 20000 || n > 80000) return null;
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.round(n) * 86400000).toISOString().slice(0, 10);
}

function cellText(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object' && value.text != null) return String(value.text).trim();
  if (typeof value === 'object' && value.result != null) return cellText(value.result);
  return String(value).trim();
}

function cellDate(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return excelSerialToIso(value) || String(value);
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return excelSerialToIso(s) || s;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

/**
 * Import warehouse prep Excel: phone + Customer(office) + invoice date.
 */
async function importPrepFile(filePath, { onProgress } = {}) {
  const batchId = await createBatch({
    type: 'prep',
    sourceFile: path.basename(filePath),
  });

  const officeCache = new Map();
  const touchedOffices = new Set();
  let rowsRead = 0;
  let upserted = 0;
  let created = 0;
  let skipped = 0;
  let rowIndex = 0;

  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: 'emit',
    sharedStrings: 'cache',
    styles: 'ignore',
    worksheets: 'emit',
  });

  for await (const worksheetReader of workbook) {
    for await (const row of worksheetReader) {
      rowIndex += 1;
      const values = row.values || [];
      const cells = [];
      for (let i = 1; i < values.length; i += 1) cells.push(values[i]);

      if (rowIndex === 1) continue;
      if (!cells.some((c) => cellText(c))) continue;

      rowsRead += 1;
      const itemCode = cellText(cells[0]);
      const phone = normalizePhone(cells[1]);
      if (!phone) {
        skipped += 1;
        continue;
      }

      const invoices = [];
      for (let i = 2; i <= 10; i += 1) {
        const inv = cellText(cells[i]);
        if (inv) invoices.push(inv);
      }
      const assignedDate = cellDate(cells[11]) || null;
      const officeName = cellText(cells[12]);
      if (!officeName) {
        skipped += 1;
        continue;
      }

      let office = officeCache.get(officeName);
      if (!office) {
        office = await ensureOffice(officeName);
        officeCache.set(officeName, office);
      }
      touchedOffices.add(office.id);

      const result = await upsertAssignedLine({
        phone,
        officeId: office.id,
        itemCode,
        invoiceNb: invoices[0] || '',
        assignedDate,
        batchId,
      });

      upserted += 1;
      if (result.created) created += 1;

      if (onProgress && upserted % 25000 === 0) {
        onProgress({ stage: 'prep', upserted, offices: touchedOffices.size });
      }
    }
  }

  const stats = {
    rows_read: rowsRead,
    upserted,
    activated: 0,
    orphans: 0,
    offices_touched: touchedOffices.size,
    notes: `created=${created}; skipped=${skipped}`,
  };
  await finishBatch(batchId, stats);

  return {
    batchId,
    type: 'prep',
    ...stats,
    created,
    skipped,
  };
}

module.exports = { importPrepFile, cellText, cellDate };
