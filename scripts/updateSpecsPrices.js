// scripts/updateSpecsPrices.js
require('dotenv').config();

const firestore = require('../lib/firestore'); // or './lib/firestore' from root

// TODO: adjust this to however Specs search actually works.
// Many WooCommerce shops use ?s=<query>&post_type=product
function buildSpecsSearchUrl(gtin) {
  // EXAMPLE – you must confirm / change this:
  return `https://specsonline.com/?s=${encodeURIComponent(gtin)}&post_type=product`;
}

// ---- IMPORTANT ----
// You *must* inspect a Specs product page in your browser DevTools
// and update PRICE_REGEX to match their markup.
//
// Example for WooCommerce stores:
//
//   <span class="woocommerce-Price-amount amount">
//      <bdi>$19.99</bdi>
//   </span>
//
// In that case, something like this might work:
//
// const PRICE_REGEX = /woocommerce-Price-amount[^>]*>\\s*<.*?>\\s*\\$?([0-9.,]+)/;
//
// You *must* adjust this based on real HTML.
const PRICE_REGEX = /TODO_REPLACE_THIS_WITH_REAL_SELECTOR/;

async function fetchSpecsPrice(gtin) {
  const url = buildSpecsSearchUrl(gtin);
  console.log(`Fetching Specs price for GTIN ${gtin} from: ${url}`);

  let res;
  try {
    res = await fetch(url, {
      // Spoof a browser-ish UA. Still must respect Terms of Use.
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } catch (err) {
    console.warn(`Network error for ${gtin}:`, err.message);
    return null;
  }

  if (!res.ok) {
    console.warn(`Specs request failed for ${gtin}: HTTP ${res.status}`);
    return null;
  }

  const html = await res.text();

  const m = html.match(PRICE_REGEX);
  if (!m) {
    console.warn(`No price match in Specs HTML for GTIN ${gtin}`);
    return null;
  }

  const raw = m[1].replace(/,/g, '').trim();
  const price = Number(raw);
  if (Number.isNaN(price)) {
    console.warn(`Parsed invalid price "${raw}" for GTIN ${gtin}`);
    return null;
  }

  return price;
}

// Optional: simple delay between requests so you don't hammer them
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateAllSpecsPrices() {
  console.log('Starting Specs price sync from gtinMeta…');

  const col = firestore.collection('gtinMeta');
  const snapshot = await col.get();

  console.log(`Found ${snapshot.size} GTIN meta docs.`);

  let processed = 0;
  let updated = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const gtin = data.gtin || doc.id;

    if (!gtin) {
      console.log(`Skipping doc ${doc.id} – no GTIN`);
      continue;
    }

    processed += 1;
    console.log(`\n[${processed}/${snapshot.size}] Processing GTIN ${gtin}`);

    const price = await fetchSpecsPrice(gtin);

    if (price == null) {
      console.log(`No Specs price found for ${gtin}`);
      // Optional: you can still mark checkedAt, with price null:
      await doc.ref.set(
        {
          specsPrice: null,
          specsPriceCurrency: 'USD',
          specsPriceCheckedAt: new Date().toISOString(),
        },
        { merge: true }
      );
      continue;
    }

    await doc.ref.set(
      {
        specsPrice: price,
        specsPriceCurrency: 'USD',
        specsPriceCheckedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    updated += 1;
    console.log(`✔ Updated Specs price for GTIN ${gtin}: ${price}`);

    // gentle delay – tune as needed
    await sleep(1500);
  }

  console.log(
    `\nDone. Processed ${processed} docs, updated ${updated} Specs prices.`
  );
}

updateAllSpecsPrices().catch((err) => {
  console.error('Fatal error during Specs price sync:', err);
  process.exit(1);
});
