// scripts/syncSheetToFirestore.js
require("../lib/loadEnv"); // adjust relative path

const { google } = require('googleapis');

const firestore = require('../lib/firestore'); // or './lib/firestore' from root

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

async function syncSheetToFirestore() {
  const sheetId = process.env.COST_SHEET_ID;
  const range = process.env.COST_SHEET_RANGE || 'Sheet1!A2:E';

  if (!sheetId) {
    throw new Error('COST_SHEET_ID is not set in .env');
  }

  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });

  const rows = res.data.values || [];
  console.log(`Loaded ${rows.length} rows from sheet`);

  const batch = firestore.batch();
  const col = firestore.collection('gtinMeta');

  for (const row of rows) {
    const [gtin, sku, itemName, vendorName, unitCostStr] = row;

    if (!gtin) continue;

    const docRef = col.doc(gtin);
    const unitCost =
      unitCostStr !== undefined && unitCostStr !== ''
        ? parseFloat(unitCostStr)
        : null;

    batch.set(
      docRef,
      {
        gtin,
        sku: sku || null,
        itemName: itemName || null,
        vendorName: vendorName || null,
        unitCost,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  }

  await batch.commit();
  console.log(`Synced ${rows.length} rows into Firestore.`);
}

syncSheetToFirestore().catch((err) => {
  console.error('Error syncing sheet to Firestore:', err);
  process.exit(1);
});
