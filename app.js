require('dotenv').config();

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const path = require('path');
const { Firestore } = require('@google-cloud/firestore');
// Use the legacy Square client for now (simpler with Node.js CommonJS)
const { Client, Environment } = require('square/legacy');
const { syncAllMerchants } = require('./inventorySync');
const firestore = new Firestore();

const app = express();

// Behind Cloud Run / proxy
app.set('trust proxy', 1);

// Parse JSON once, globally
app.use(express.json());

// 🔹 Session middleware – MUST be before passport.session()
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-session-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production', // only send cookies over HTTPS in prod
      sameSite: 'lax',
    },
  })
);

// static files
app.use(express.static(path.join(__dirname, 'public')));

// --- Config from environment (coming from Secret Manager via Cloud Run) ---
const SQUARE_APP_ID = process.env.SQUARE_APP_ID;
const SQUARE_APP_SECRET = process.env.SQUARE_APP_SECRET;
const SQUARE_ENV = process.env.SQUARE_ENV || 'sandbox';

// IMPORTANT: replace this with your real Cloud Run URL
// e.g. 'https://square-inventory-sync-xxxxxx-uc.a.run.app/oauth/callback'
const REDIRECT_URI =
  process.env.SQUARE_REDIRECT_URI ||
  'https://square-inventory-sync-976955084378.us-central1.run.app/oauth/callback';

// Square client used for OAuth calls (no access token needed for obtainToken)
const squareOAuthClient = new Client({
  environment: SQUARE_ENV === 'sandbox' ? Environment.Sandbox : Environment.Production,
});

function createSquareClient(accessToken, env) {
  return new Client({
    environment: env === 'sandbox' ? Environment.Sandbox : Environment.Production,
    bearerAuthCredentials: { accessToken },
  });
}

// views
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));

// Passport must come *after* session
app.use(passport.initialize());
app.use(passport.session());

// 🔹 Make user available in all views
app.use((req, res, next) => {
  res.locals.user = req.user; // will be { id, email } from serializeUser
  next();
});

// Only allow specific Google Workspace / emails
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

// Configure Google strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL
    },
    (accessToken, refreshToken, profile, done) => {
      const email = (profile.emails?.[0]?.value || '').toLowerCase();
      console.log('Google profile emails:', profile.emails);
      console.log('Email from Google:', email);
      console.log('ALLOWED_EMAILS:', ALLOWED_EMAILS);

      if (!email || (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(email))) {
        return done(null, false, { message: 'Not allowed' });
      }
      return done(null, { id: profile.id, email });
    }
  )
);


// Serialize user (store minimal info in session)
passport.serializeUser((user, done) => {
  done(null, { id: user.id, email: user.email });
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// Middleware to protect routes
function requireLogin(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.redirect('/auth/google');
}

// Start login
app.get(
  '/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Callback after Google login
app.get(
  '/auth/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/login-not-allowed',
    successRedirect: '/dashboard', // or wherever your dashboard lives
  })
);

app.get('/login-not-allowed', (req, res) => {
  res.status(403).send('Your Google account is not allowed to access this app.');
});

app.post('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => res.redirect('/auth/google'));
  });
});


app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// --- Debug route to confirm env values ---
app.get('/debug/env', (req, res) => {
  res.json({
    env: SQUARE_ENV,
    hasAppId: !!SQUARE_APP_ID,
    hasSecret: !!SQUARE_APP_SECRET,
    redirectUri: REDIRECT_URI,
  });
});

// Master dashboard – all merchants
app.get('/dashboard', requireLogin, async (req, res) => {
  try {
    // All inventory (master view)
    const invSnapshot = await firestore
      .collection('inventory')
      .where('state', '==', 'IN_STOCK')
      .get();

    const rows = invSnapshot.docs.map(d => d.data());

    // Load all merchants for the menu
    const merchantsSnap = await firestore.collection('merchants').get();
    const merchants = merchantsSnap.docs.map(d => ({
      id: d.id,
      ...d.data(),
    }));

    res.render('dashboard', {
      rows,
      merchants,
      merchantId: null,
      merchant: null,
      currentView: 'item',
      pageTitle: 'Inventory Dashboard',
      activePage: 'dashboard',   // 👈 add this
    });
  } catch (err) {
    console.error('Error loading dashboard', err);
    res.status(500).send('Failed to load dashboard: ' + err.message);
  }
});

// Reports page
app.get('/reports', requireLogin, async (req, res) => {
  const metrics = {/* ... */};
  const syncRuns = [];

  const merchantsSnap = await firestore.collection('merchants').get();
  const merchants = merchantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  res.render('reports', {
    metrics,
    syncRuns,
    merchants,        // 👈 now defined
    activePage: 'reports',
  });
});



// Per-merchant dashboard – single Square account
app.get('/dashboard/:merchantId', requireLogin, async (req, res) => {
  const { merchantId } = req.params;

  try {
    const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
    if (!merchantDoc.exists) {
      return res.status(404).send(`Merchant ${merchantId} not found`);
    }

    // Inventory for this merchant only
    const invSnapshot = await firestore
      .collection('merchants')
      .doc(merchantId)
      .collection('inventory')
      .where('state', '==', 'IN_STOCK')
      .get();

    const rows = invSnapshot.docs.map(d => d.data());

    // Load all merchants for the menu
    const merchantsSnap = await firestore.collection('merchants').get();
    const merchants = merchantsSnap.docs.map(d => ({
      id: d.id,
      ...d.data(),
    }));

    res.render('dashboard', {
      rows,
      merchants,
      merchantId,
      merchant: merchantDoc.data(),
    });
  } catch (err) {
    console.error('Error loading merchant dashboard', err);
    res.status(500).send('Failed to load merchant dashboard: ' + err.message);
  }
});


// --- 1) Start Square OAuth – connect a new Square business ---
app.get('/connect-square', requireLogin, (req, res) => {
  if (!SQUARE_APP_ID) {
    return res.status(500).send('SQUARE_APP_ID is not configured');
  }

  const state = 'csrf-or-user-id'; // later you can make this dynamic

  const scopes = [
    'MERCHANT_PROFILE_READ',
    'ITEMS_READ',
    'ITEMS_WRITE',       // 👈 add this
    'INVENTORY_READ',
    'INVENTORY_WRITE',   // if you’re using it
    'ORDERS_READ',       // or whatever else you already had
  ].join(' ');

  const authBase =
    SQUARE_ENV === 'sandbox'
      ? 'https://connect.squareupsandbox.com/oauth2/authorize'
      : 'https://connect.squareup.com/oauth2/authorize';

  const url =
    `${authBase}?client_id=${encodeURIComponent(SQUARE_APP_ID)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&session=false` +
    `&state=${encodeURIComponent(state)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  res.redirect(url);
});

// --- 2) OAuth callback – exchange code for tokens, store merchant in Firestore ---
app.get('/oauth/callback', requireLogin, async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error('Square returned error:', error, error_description);
    return res
      .status(400)
      .send(`Square OAuth error: ${error} – ${error_description || ''}`);
  }

  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

  try {
    console.log('Exchanging code for tokens...');

    const { result } = await squareOAuthClient.oAuthApi.obtainToken({
      clientId: SQUARE_APP_ID,
      clientSecret: SQUARE_APP_SECRET,
      code,
      grantType: 'authorization_code',
      redirectUri: REDIRECT_URI,
    });

    console.log('Token result:', JSON.stringify(result, null, 2));

    const { accessToken, refreshToken, merchantId } = result;

    // Now use a client with the merchant's access token to get their profile
    const merchantClient = new Client({
      environment: SQUARE_ENV === 'sandbox' ? Environment.Sandbox : Environment.Production,
      bearerAuthCredentials: {
        accessToken,
      },
    });

    const merchantRes = await merchantClient.merchantsApi.retrieveMerchant(merchantId);
    console.log('Merchant response:', JSON.stringify(merchantRes.result, null, 2));

    const merchant = merchantRes.result.merchant;

    // Store merchant+tokens in Firestore
    await firestore.collection('merchants').doc(merchantId).set(
      {
        merchant_id: merchantId,
        business_name: merchant.businessName,
        access_token: accessToken,
        refresh_token: refreshToken,
        env: SQUARE_ENV,
        connected_at: new Date().toISOString(),
      },
      { merge: true }
    );

    res.send(
      `Square business connected successfully for merchant "${merchant.businessName}". You can close this window.`
    );
  } catch (err) {
    console.error('OAuth error', err);

    // Try to pull out detailed info from Square's error object
    let details = '';

    try {
      if (err.errors) {
        details = JSON.stringify(err.errors, null, 2);
      } else if (err.body) {
        details = JSON.stringify(err.body, null, 2);
      } else {
        details = JSON.stringify(err, null, 2);
      }
    } catch (e) {
      details = String(err);
    }

    res
      .status(500)
      .send(
        `<h2>OAuth error from Square</h2>` +
        `<p><strong>Message:</strong> ${err.message || 'No message'}</p>` +
        `<pre>${details}</pre>`
      );
  }

});

app.get('/debug/firestore-write', requireLogin, async (req, res) => {
  try {
    const testRef = firestore.collection('debug').doc('test');
    await testRef.set(
      {
        written_at: new Date().toISOString(),
      },
      { merge: true }
    );
    res.send('Firestore write OK');
  } catch (e) {
    console.error('Firestore write error', e);
    res.status(500).send('Firestore write FAILED: ' + e.message);
  }
});

// Task endpoint to sync inventory for all merchants
app.post('/tasks/sync-inventory', async (req, res) => {
  try {
    await syncAllMerchants();
    res.status(200).send('Inventory sync completed');
  } catch (err) {
    console.error('Error in /tasks/sync-inventory', err);
    res.status(500).send('Inventory sync failed: ' + err.message);
  }
});

// GTIN master dashboard – one row per GTIN, columns per location
app.get('/dashboard-gtin', requireLogin, async (req, res) => {
  try {
    // Load ALL inventory with a GTIN
    const invSnapshot = await firestore
      .collection('inventory')
      .where('gtin', '!=', null)
      .get();

    const gtinMap = {};
    const locationKeySet = new Set();

    invSnapshot.docs.forEach(doc => {
      const d = doc.data();
      if (!d.gtin) return;

      // Build a unique "location key" that includes merchant + location
      const merchantName = d.merchant_name || d.merchant_id || '';
      const locationName = d.location_name || d.location_id || '';
      const locKey = `${merchantName} – ${locationName}`.trim();

      locationKeySet.add(locKey);

      if (!gtinMap[d.gtin]) {
        gtinMap[d.gtin] = {
          gtin: d.gtin,
          item_name: d.item_name || '',
          category_name: d.category_name || '',
          sku: d.sku || '',
          pricesByLocation: {}, // { locKey: { price, currency, merchant_id, location_id, variation_id } }
        };
      }

      // Prefer non-null price
      const price = (d.price !== undefined && d.price !== null)
        ? Number(d.price)
        : null;
      const currency = d.currency || '';

      gtinMap[d.gtin].pricesByLocation[locKey] = {
        price,
        currency,
        merchant_id: d.merchant_id,
        location_id: d.location_id,
        variation_id: d.variation_id,
      };
    });

    // 🔹🔹 ADD MASTER NAME OVERLAY RIGHT HERE 🔹🔹
    const gtinList = Object.keys(gtinMap);

    if (gtinList.length > 0) {
      // For each GTIN, look up canonical name in item_master/{gtin}
      await Promise.all(
        gtinList.map(async (gtin) => {
          try {
            const masterDoc = await firestore
              .collection('item_master')
              .doc(gtin)
              .get();

            if (masterDoc.exists) {
              const md = masterDoc.data();
              if (md.canonical_name) {
                // override item_name with master canonical name
                gtinMap[gtin].item_name = md.canonical_name;
              }
            }
          } catch (e) {
            console.error('Error loading item_master for GTIN', gtin, e);
          }
        })
      );
    }
    // 🔹🔹 END MASTER NAME OVERLAY 🔹🔹

    const locations = Array.from(locationKeySet).sort();

    // Convert map to sorted array (by item_name then GTIN)
    const rows = Object.values(gtinMap).sort((a, b) => {
      const an = (a.item_name || '').toLowerCase();
      const bn = (b.item_name || '').toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return (a.gtin || '').localeCompare(b.gtin || '');
    });

    // We still pass merchants for navigation
    const merchantsSnap = await firestore.collection('merchants').get();
    const merchants = merchantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    res.render('dashboard_gtin', {
      rows,
      locations,
      merchants,
      pageTitle: 'Price Mismatch Dashboard',
      activePage: 'dashboard-gtin'
    });
  } catch (err) {
    console.error('Error loading GTIN master dashboard', err);
    res.status(500).send('Failed to load GTIN master dashboard: ' + err.message);
  }
});

app.post('/api/update-price', async (req, res) => {
  try {
    const { merchantId, variationId, price, currency } = req.body;

    if (!merchantId || !variationId || price == null) {
      return res.status(400).json({ error: 'merchantId, variationId, and price are required' });
    }

    const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
    if (!merchantDoc.exists) {
      return res.status(404).json({ error: 'Merchant not found' });
    }

    const merchant = merchantDoc.data();
    const client = createSquareClient(merchant.access_token, merchant.env || 'sandbox');

    const numericPrice = Number(price);
    if (Number.isNaN(numericPrice)) {
      return res.status(400).json({ error: 'Invalid price value' });
    }

    // 1) Retrieve the variation from Square
    const variationRes = await client.catalogApi.retrieveCatalogObject(variationId, true);
    const variationObj = variationRes.result.object;

    if (!variationObj || variationObj.type !== 'ITEM_VARIATION') {
      return res.status(400).json({ error: 'Catalog object is not an ITEM_VARIATION' });
    }

    const variationData = variationObj.itemVariationData || {};

    // 2) Update the base priceMoney
    variationData.priceMoney = {
      amount: Math.round(numericPrice * 100),
      currency: currency || variationData.priceMoney?.currency || 'USD',
    };

    variationObj.itemVariationData = variationData;

    // 3) Upsert back to Square
    await client.catalogApi.upsertCatalogObject({
      idempotencyKey: `price-${variationId}-${Date.now()}`,
      object: variationObj,
    });

    // 4) Update Firestore rows for this merchant + variation
    const invSnapshot = await firestore
      .collection('inventory')
      .where('merchant_id', '==', merchantId)
      .where('variation_id', '==', variationId)
      .get();

    const batch = firestore.batch();
    const nowIso = new Date().toISOString();

    invSnapshot.forEach((doc) => {
      batch.set(
        doc.ref,
        { price: numericPrice, currency: variationData.priceMoney.currency, updated_at: nowIso },
        { merge: true }
      );

      const merchantInvRef = firestore
        .collection('merchants')
        .doc(merchantId)
        .collection('inventory')
        .doc(doc.id);

      batch.set(
        merchantInvRef,
        { price: numericPrice, currency: variationData.priceMoney.currency, updated_at: nowIso },
        { merge: true }
      );
    });

    await batch.commit();

    return res.json({ success: true });
  } catch (err) {
    console.error('Error in /api/update-price', err);
    res.status(500).json({ error: err.message || 'Failed to update price' });
  }
});

app.post('/api/update-item-name', async (req, res) => {
  try {
    const { gtin, itemName } = req.body;

    if (!gtin || !itemName) {
      return res.status(400).json({ error: 'gtin and itemName are required' });
    }

    const trimmedName = String(itemName).trim();
    if (!trimmedName) {
      return res.status(400).json({ error: 'itemName cannot be empty' });
    }

    const nowIso = new Date().toISOString();

    // 1) Save / update master item name
    await firestore.collection('item_master').doc(gtin).set(
      {
        canonical_name: trimmedName,
        updated_at: nowIso,
      },
      { merge: true }
    );

    // 2) Find all inventory docs with this GTIN (across all merchants & locations)
    const invSnapshot = await firestore
      .collection('inventory')
      .where('gtin', '==', gtin)
      .get();

    if (invSnapshot.empty) {
      // nothing to propagate, but master saved fine
      return res.json({ success: true, updatedItems: 0 });
    }

    // Build unique (merchant_id, item_id) combinations
    const comboMap = new Map(); // key: merchantId|itemId
    invSnapshot.forEach((doc) => {
      const d = doc.data();
      const merchantId = d.merchant_id;
      const itemId = d.item_id;

      if (!merchantId || !itemId) return;

      const key = `${merchantId}|${itemId}`;
      if (!comboMap.has(key)) {
        comboMap.set(key, { merchantId, itemId });
      }
    });

    // 3) For each merchant + item, update the ITEM name in Square
    for (const { merchantId, itemId } of comboMap.values()) {
      const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
      if (!merchantDoc.exists) continue;

      const merchant = merchantDoc.data();
      const client = createSquareClient(merchant.access_token, merchant.env || 'sandbox');

      try {
        const itemRes = await client.catalogApi.retrieveCatalogObject(itemId, true);
        const itemObj = itemRes.result.object;

        if (!itemObj || itemObj.type !== 'ITEM') continue;

        itemObj.itemData = itemObj.itemData || {};
        itemObj.itemData.name = trimmedName;

        await client.catalogApi.upsertCatalogObject({
          idempotencyKey: `name-${itemId}-${Date.now()}`,
          object: itemObj,
        });
      } catch (e) {
        console.error(`Failed to update name in Square for merchant ${merchantId}, item ${itemId}`, e);
      }
    }

    // 4) Update Firestore item_name for all inventory docs with this GTIN
    const batch = firestore.batch();

    invSnapshot.forEach((doc) => {
      batch.set(
        doc.ref,
        { item_name: trimmedName, updated_at: nowIso },
        { merge: true }
      );

      const d = doc.data();
      if (d.merchant_id) {
        const merchantInvRef = firestore
          .collection('merchants')
          .doc(d.merchant_id)
          .collection('inventory')
          .doc(doc.id);

        batch.set(
          merchantInvRef,
          { item_name: trimmedName, updated_at: nowIso },
          { merge: true }
        );
      }
    });

    await batch.commit();

    return res.json({
      success: true,
      updatedItems: comboMap.size,
      updatedDocs: invSnapshot.size,
    });
  } catch (err) {
    console.error('Error in /api/update-item-name', err);
    res.status(500).json({ error: err.message || 'Failed to update item name' });
  }
});

app.post('/api/analyze-gtin', requireLogin, async (req, res) => {
  try {
    const { gtin } = req.body;
    if (!gtin) {
      return res.status(400).json({ error: 'gtin is required' });
    }

    // 1) Load inventory rows for this GTIN
    const invSnapshot = await firestore
      .collection('inventory')
      .where('gtin', '==', gtin)
      .get();

    if (invSnapshot.empty) {
      return res.status(404).json({ error: 'No items found for this GTIN' });
    }

    const items = invSnapshot.docs.map(d => {
      const data = d.data();
      return {
        merchant_name: data.merchant_name || data.merchant_id || '',
        item_name: data.item_name || '',
        category_name: data.category_name || '',
        sku: data.sku || '',
      };
    });

    // 2) Load master canonical name if exists
    const masterDoc = await firestore.collection('item_master').doc(gtin).get();
    const masterName = masterDoc.exists ? (masterDoc.data().canonical_name || '') : '';

    const payload = {
      gtin,
      item_master_name: masterName,
      items,
    };

    // 3) Call AI model (implement this helper)
    const aiResult = await analyzeGtinWithAI(payload);

    res.json(aiResult);
  } catch (err) {
    console.error('Error in /api/analyze-gtin', err);
    res.status(500).json({ error: err.message || 'Failed to analyze GTIN' });
  }
});

// Only start the server if this file is run directly (node app.js / nodemon app.js)
if (require.main === module) {
  const port = process.env.PORT || 8080;
  app.listen(port, () => {
    console.log(`Dev server listening on port ${port}`);
  });
}

module.exports = app;

