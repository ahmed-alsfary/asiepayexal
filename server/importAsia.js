const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { createBatch, finishBatch, applyAsiaActivation } = require('./db');
const { normalizePhone } = require('./phone');

function cleanDate(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s || null;
}

/**
 * Import Asia activation CSV and match by phone.
 */
async function importAsiaFile(filePath, { onProgress } = {}) {
  const batchId = await createBatch({
    type: 'asia',
    sourceFile: path.basename(filePath),
  });

  let rowsRead = 0;
  let upserted = 0;
  let activated = 0;
  let orphans = 0;
  let skipped = 0;

  await new Promise((resolve, reject) => {
    const parser = fs.createReadStream(filePath).pipe(
      parse({
        columns: (header) =>
          header.map((h) =>
            String(h || '')
              .replace(/^\uFEFF/, '')
              .trim()
              .toUpperCase()
          ),
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
      })
    );

    parser.on('data', (row) => {
      parser.pause();
      (async () => {
        try {
          rowsRead += 1;
          const phone = normalizePhone(row.SUB_MSISDN);
          if (!phone) {
            skipped += 1;
            parser.resume();
            return;
          }

          const result = await applyAsiaActivation({
            phone,
            activationDate: cleanDate(row.ACTIVATION_DT),
            bundleName: row.BUNDLE_NAME || '',
            bundleRevenue: row.ALL_BUN_REVN || '',
            typeOfProd: row.TYPE_OF_PROD || '',
            dealerMsisdn: row.DEALER_MSISDN || '',
            batchId,
          });

          upserted += 1;
          if (result.orphan) orphans += 1;
          if (result.activated) activated += 1;

          if (onProgress && upserted % 1000 === 0) {
            onProgress({ stage: 'asia', upserted, activated, orphans });
          }
          parser.resume();
        } catch (err) {
          reject(err);
        }
      })();
    });

    parser.on('error', reject);
    parser.on('end', resolve);
  });

  const stats = {
    rows_read: rowsRead,
    upserted,
    activated,
    orphans,
    offices_touched: 0,
    notes: `skipped=${skipped}`,
  };
  await finishBatch(batchId, stats);

  return {
    batchId,
    type: 'asia',
    ...stats,
    skipped,
  };
}

module.exports = { importAsiaFile };
