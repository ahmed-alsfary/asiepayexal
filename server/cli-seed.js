#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { importPrepFile } = require('./importPrep');
const { importAsiaFile } = require('./importAsia');
const { getDbStats, listOffices, closeDb } = require('./db');

async function main() {
  const root = path.join(__dirname, '..');
  const prep = path.join(root, 'تجهيز كامل.xlsx');
  const asia = path.join(
    root,
    'QualityActivationBundleReport_U3632_R10201_085926_20260905.csv'
  );

  if (fs.existsSync(prep)) {
    console.log('Importing prep…');
    console.time('prep');
    const prepResult = await importPrepFile(prep, {
      onProgress: (p) => console.log(p),
    });
    console.timeEnd('prep');
    console.log(prepResult);
  } else {
    console.log('Prep file missing, skip');
  }

  if (fs.existsSync(asia)) {
    console.log('Importing asia…');
    console.time('asia');
    const asiaResult = await importAsiaFile(asia, {
      onProgress: (p) => console.log(p),
    });
    console.timeEnd('asia');
    console.log(asiaResult);
  } else {
    console.log('Asia file missing, skip');
  }

  console.log('stats', getDbStats());
  console.log('top offices', listOffices({ limit: 5 }).offices);
  closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
