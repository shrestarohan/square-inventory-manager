require('dotenv').config();

const bcrypt = require('bcryptjs');
const LocalStrategy = require('passport-local').Strategy;
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const path = require('path');

// Use the legacy Square client for now (simpler with Node.js CommonJS)
const { Client, Environment } = require('square/legacy');
const { syncAllMerchants } = require('./lib/inventorySync');
const { runBuildGtinMatrix } = require('./scripts/buildGtinMatrix');

const firestore = require('./lib/firestore'); // or './lib/firestore' from root

const app = express();
app.use((req, res, next) => {
  console.log('REQ:', req.method, req.originalUrl);
  next();
});

app.locals.firestore = firestore;

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
    proxy: true,
    cookie: {
      secure: 'auto',
      sameSite: 'lax',
    },
  })
);


// static files
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.locals.appEnv = process.env.APP_ENV || process.env.NODE_ENV || 'dev';
  next();
});

// Middleware to load last full sync status for all views
app.use(async (req, res, next) => {
  try {
    const doc = await firestore
      .collection('meta')
      .doc('sync_status')
      .get();

    res.locals.syncStatus = doc.exists ? doc.data() : null;
  } catch (e) {
    console.error('Error loading sync_status meta doc:', e);
    res.locals.syncStatus = null;
  }
  next();
});

// --- Config from environment (coming from Secret Manager via Cloud Run) ---
const SQUARE_APP_ID = process.env.SQUARE_APP_ID;
const SQUARE_APP_SECRET = process.env.SQUARE_APP_SECRET;
const SQUARE_ENV = process.env.SQUARE_ENV || 'sandbox';

// IMPORTANT: replace this with your real Cloud Run URL
// e.g. 'https://square-inventory-sync-xxxxxx-uc.a.run.app/oauth/callback'
const REDIRECT_URI =
  process.env.SQUARE_REDIRECT_URI ||
  'https://square-inventory-sync-976955084378.us-central1.run.app/square/oauth/callback';


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
  .split(';')
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
        return done(null, false, { message: 'Your Google account is not allowed to access this app.' });
      }
      return done(null, { id: profile.id, email });
    }
  )
);

passport.use(new LocalStrategy(
  { usernameField: 'username', passwordField: 'password' },
  async (username, password, done) => {
    try {
      const input = (username || '').trim().toLowerCase();

      // Option A: doc id is the email
      let doc = await firestore.collection('users').doc(input).get();

      // Option B: lookup by username field
      if (!doc.exists) {
        const snap = await firestore.collection('users')
          .where('username', '==', input)
          .limit(1)
          .get();
        if (!snap.empty) doc = snap.docs[0];
      }

      if (!doc.exists) return done(null, false, { message: 'Invalid username or password' });

      const data = doc.data();
      const ok = await bcrypt.compare(password, data.passwordHash || '');
      if (!ok) return done(null, false, { message: 'Invalid username or password' });

      return done(null, { id: doc.id, email: data.email || doc.id, username: data.username || null, role: data.role || 'user' });
    } catch (e) {
      return done(e);
    }
  }
));

// Serialize user (store minimal info in session)
passport.serializeUser((user, done) => {
  done(null, { id: user.id, email: user.email });
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// Auth guard, Middleware to protect routes
function requireLogin(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  const nextUrl = encodeURIComponent(req.originalUrl || '/dashboard');
  return res.redirect(`/login?next=${nextUrl}`);
}

const comingSoon = require('./routes/comingSoon');

const inventoryIntegrityRoutes = require('./routes/inventoryIntegrityRoutes');
app.use('/api', requireLogin, inventoryIntegrityRoutes);

app.get('/inventory-integrity', requireLogin, async (req, res) => {
  const merchantsSnap = await firestore.collection('merchants').get();
  const merchants = merchantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  res.render('inventory-integrity', {
    merchants,
    merchantId: null,
    merchant: null,
  });
});

const reorderRoutes = require('./routes/reorderRoutes');
app.use('/api', requireLogin, inventoryIntegrityRoutes);

app.get('/reorder', requireLogin, comingSoon('Reorder Recommendations'));
/*
app.get('/reorder', requireLogin, async (req, res) => {
  const merchantsSnap = await firestore.collection('merchants').get();
  const merchants = merchantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // easiest v1: build locations list from Square locations of selected merchant
  // For now, pass empty array and we’ll add /api/locations next if needed.
  res.render('reorder', {
    merchants,
    merchantId: null,
    merchant: null,
    locations: [], // we'll fill this next
    activePage: 'reorder',
  });
});*/

app.get('/reorder/:merchantId', requireLogin, async (req, res) => {
  const { merchantId } = req.params;

  const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
  if (!merchantDoc.exists) return res.status(404).send('Merchant not found');

  const merchantsSnap = await firestore.collection('merchants').get();
  const merchants = merchantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // quick locations list from your location_index (if you store locKey = merchant|location)
  const locSnap = await firestore.collection('location_index').get();
  const locations = locSnap.docs
    .map(d => d.data())
    .filter(x => (x.merchant_id === merchantId) || (x.locKey || '').startsWith(merchantId + '|'))
    .map(x => ({
      location_id: x.location_id || (x.locKey ? x.locKey.split('|')[1] : ''),
      location_name: x.location_name || x.location_id || '',
    }))
    .filter(x => x.location_id);

  res.render('reorder', {
    merchants,
    merchantId,
    merchant: merchantDoc.data(),
    locations,
    activePage: 'reorder',
  });
});

const { syncSalesDailyForMerchant } = require('./scripts/syncSalesDaily');

app.get('/tasks/sync-sales-daily/:merchantId', requireLogin, async (req, res) => {
  try {
    const out = await syncSalesDailyForMerchant({ merchantId: req.params.merchantId, days: 28 });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


// Login screen
app.get('/login', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) return res.redirect('/dashboard');

  res.render('login', {
    next: req.query.next || '/dashboard',
    error: req.query.error || null
  });
});

// Local login (username/password)
app.post('/login', (req, res, next) => {
  const nextUrl = req.body.next || '/dashboard';
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.redirect(`/login?error=${encodeURIComponent(info?.message || 'Login failed')}&next=${encodeURIComponent(nextUrl)}`);
    req.logIn(user, (e) => {
      if (e) return next(e);
      if (req.body.remember) req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 14; // 14 days
      return res.redirect(nextUrl);
    });
  })(req, res, next);
});

// Google SSO (pass next via state)
app.get('/auth/google', (req, res, next) => {
  console.log('➡️  /auth/google hit');
  next();
}, (req, res, next) => {
  const nextUrl = req.query.next || '/dashboard';
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',
    state: encodeURIComponent(nextUrl),
  })(req, res, next);
});

// Callback after Google login
app.get('/auth/google/callback',
  (req, res, next) => { console.log('⬅️  /auth/google/callback hit', req.query); next(); },
  passport.authenticate('google', {
    failureRedirect: '/login?error=' + encodeURIComponent('Your Google account is not allowed to access this app.'),
  }),
  (req, res) => {
    console.log('✅ Google auth success user:', req.user);
    const nextUrl = req.query.state ? decodeURIComponent(req.query.state) : '/dashboard';
    req.session.save(() => res.redirect(nextUrl));
  }
);

// Logout
app.post('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session?.destroy(() => res.redirect('/login'));
  });
});

//Home Page
app.get('/', (req, res) => {
  res.redirect('/login');
});

// --- Debug route to confirm env values ---
app.get('/debug/env', (req, res) => {
  res.json({
    nodeEnv: process.env.NODE_ENV || null,
    hasSessionSecret: !!process.env.SESSION_SECRET,

    hasGoogleClientId: !!process.env.GOOGLE_CLIENT_ID,
    hasGoogleClientSecret: !!process.env.GOOGLE_CLIENT_SECRET,
    googleCallbackUrl: process.env.GOOGLE_CALLBACK_URL || null,
    allowedEmails: (process.env.ALLOWED_EMAILS || '').split(';').filter(Boolean),

    env: SQUARE_ENV,
    hasAppId: !!SQUARE_APP_ID,
    hasSecret: !!SQUARE_APP_SECRET,
    redirectUri: REDIRECT_URI,
  });
});


// Master dashboard – all merchants
app.get('/dashboard', requireLogin, async (req, res) => {
  try {

    // Load all merchants for the menu
    const merchantsSnap = await firestore.collection('merchants').get();
    const merchants = merchantsSnap.docs.map(d => ({
      id: d.id,
      ...d.data(),
    }));

    res.render('dashboard', {
      rows: [], // render fast, client will fetch rows
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

// Per-merchant dashboard – single Square account
app.get('/dashboard/:merchantId', requireLogin, async (req, res) => {
  const { merchantId } = req.params;

  try {
    const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
    if (!merchantDoc.exists) {
      return res.status(404).send(`Merchant ${merchantId} not found`);
    }

    // Load all merchants for the menu
    const merchantsSnap = await firestore.collection('merchants').get();
    const merchants = merchantsSnap.docs.map(d => ({
      id: d.id,
      ...d.data(),
    }));

    res.render('dashboard', {
      rows: [],                 // render fast, client will fetch rows
      merchants,
      merchantId,
      merchant: merchantDoc.data(),
      activePage: 'dashboard'
    });
  } catch (err) {
    console.error('Error loading merchant dashboard', err);
    res.status(500).send('Failed to load merchant dashboard: ' + err.message);
  }
});

// Reports page
app.get('/reports', requireLogin, async (req, res) => {
  try {
    const full = req.query.full === '1';   // /reports?full=1 to run heavy scan
    const lite = !full;

    // ---------- 1) Always-fast collection counts ----------
    const merchantsAgg = await firestore.collection('merchants').count().get();
    const totalMerchants = merchantsAgg.data().count || 0;

    const masterInvAgg = await firestore.collection('inventory').count().get();
    const masterInventoryCount = masterInvAgg.data().count || 0;

    const merchantInvAgg = await firestore.collectionGroup('inventory').count().get();
    const merchantInventoryCount = merchantInvAgg.data().count || 0;

    // gtinMeta count (count() is faster than .get())
    let gtinMetaCount = 0;
    try {
      const gtinMetaAgg = await firestore.collection('gtinMeta').count().get();
      gtinMetaCount = gtinMetaAgg.data().count || 0;
    } catch (e) {
      console.warn('gtinMeta count failed:', e.message);
    }

    // ---------- 2) Merchants list for header + tables ----------
    const merchantsSnap = await firestore.collection('merchants').get();
    const merchants = merchantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // ---------- 3) Lite-mode per-merchant counts (FAST) ----------
    // This does NOT scan inventory rows; it uses aggregation per merchant.
    const perMerchantLite = [];
    if (lite) {
      for (const m of merchants) {
        try {
          const agg = await firestore
            .collection('merchants')
            .doc(m.id)
            .collection('inventory')
            .count()
            .get();

          perMerchantLite.push({
            merchantId: m.id,
            merchantName: m.business_name || m.id,
            inventoryDocCount: agg.data().count || 0,
          });
        } catch (e) {
          perMerchantLite.push({
            merchantId: m.id,
            merchantName: m.business_name || m.id,
            inventoryDocCount: null,
            error: e.message,
          });
        }
      }
    }

    // ---------- 4) Full-mode metrics (HEAVY) ----------
    let perMerchant = [];
    let dataQuality = {
      totalRealItems: 0,
      gtinCoveragePct: 0,
      skuCoveragePct: 0,
      costCoveragePct: 0,
      imageCoveragePct: 0,
      taxCoveragePct: 0,
    };

    let pricing = {
      gtinsWithAnyMismatch: 0,
      gtinsWithSpreadOver1: 0,
      gtinsWithSpreadOver3: 0,
    };

    // Optional recent sync runs (fast enough)
    let syncRuns = [];
    try {
      const syncSnap = await firestore
        .collection('syncRuns')
        .orderBy('runAt', 'desc')
        .limit(20)
        .get();
      syncRuns = syncSnap.docs.map(d => d.data());
    } catch (e) {
      console.warn('No syncRuns or query failed:', e.message);
    }

    if (full) {
      // Load gtinMeta into a map for cost coverage (still okay; usually not huge)
      const gtinMetaMap = new Map();
      try {
        const gtinSnap = await firestore.collection('gtinMeta').get();
        gtinSnap.forEach(doc => {
          const d = doc.data();
          const gtin = d.gtin || doc.id;
          if (!gtin) return;
          gtinMetaMap.set(gtin, {
            unitCost: d.unitCost ?? d.unit_cost ?? null,
          });
        });
      } catch (e) {
        console.warn('gtinMeta read failed:', e.message);
      }

      // global real coverage counts
      let globalRealItems = 0;
      let globalWithGtin = 0;
      let globalWithSku = 0;
      let globalWithCost = 0;
      let globalWithImage = 0;
      let globalWithTax = 0;

      // pricing: store min/max per GTIN (MUCH less memory than Set)
      const priceMinMaxByGtin = new Map(); // gtin -> {min, max}

      const READ_PAGE_SIZE = 800; // slightly smaller pages helps memory spikes

      for (const merchant of merchants) {
        const merchantId = merchant.id;
        const merchantName = merchant.business_name || merchantId;

        const invRef = firestore
          .collection('merchants')
          .doc(merchantId)
          .collection('inventory');

        let lastDoc = null;

        let realCount = 0;
        let syntheticCount = 0;

        const distinctGtinsTotal = new Set();
        const distinctGtinsReal = new Set();

        let itemsMissingGtin = 0;
        let itemsMissingSku = 0;
        let itemsWithImage = 0;
        let itemsWithTax = 0;

        let estInventoryValue = 0;

        // Only fetch fields you actually use (reduces payload a lot)
        while (true) {
          let q = invRef
            .orderBy('__name__')
            .select(
              'synthetic',
              'gtin',
              'sku',
              'qty',
              'price',
              'currency',
              'image_urls',
              'tax_names'
            )
            .limit(READ_PAGE_SIZE);

          if (lastDoc) q = q.startAfter(lastDoc);

          const snap = await q.get();
          if (snap.empty) break;

          snap.forEach(doc => {
            const d = doc.data();
            const isSynthetic = d.synthetic === true;

            const gtin = d.gtin || null;
            const sku = d.sku || null;

            const hasImage =
              Array.isArray(d.image_urls) ? d.image_urls.length > 0 : !!d.image_urls;
            const hasTax =
              Array.isArray(d.tax_names) ? d.tax_names.length > 0 : !!d.tax_names;

            if (isSynthetic) syntheticCount++;
            else realCount++;

            if (gtin) distinctGtinsTotal.add(gtin);
            if (gtin && !isSynthetic) distinctGtinsReal.add(gtin);

            if (!gtin) itemsMissingGtin++;
            if (!sku) itemsMissingSku++;

            if (hasImage) itemsWithImage++;
            if (hasTax) itemsWithTax++;

            if (!isSynthetic) {
              globalRealItems++;
              if (gtin) globalWithGtin++;
              if (sku) globalWithSku++;
              if (hasImage) globalWithImage++;
              if (hasTax) globalWithTax++;

              if (gtin && gtinMetaMap.has(gtin)) {
                const unitCost = gtinMetaMap.get(gtin)?.unitCost;
                if (unitCost !== null && unitCost !== undefined && !isNaN(unitCost)) {
                  globalWithCost++;
                  const qty = d.qty != null ? Number(d.qty) : 0;
                  estInventoryValue += qty * Number(unitCost);
                }
              }

              // pricing mismatch min/max
              if (gtin && d.price != null) {
                const price = Number(d.price);
                if (!isNaN(price)) {
                  const mm = priceMinMaxByGtin.get(gtin);
                  if (!mm) priceMinMaxByGtin.set(gtin, { min: price, max: price });
                  else {
                    if (price < mm.min) mm.min = price;
                    if (price > mm.max) mm.max = price;
                  }
                }
              }
            }
          });

          lastDoc = snap.docs[snap.docs.length - 1];
        }

        perMerchant.push({
          merchantId,
          merchantName,
          realCount,
          syntheticCount,
          distinctGtinsTotal: distinctGtinsTotal.size,
          distinctGtinsReal: distinctGtinsReal.size,
          itemsMissingGtin,
          itemsMissingSku,
          itemsWithImage,
          itemsWithTax,
          estInventoryValue,
        });
      }

      const pct = (part, total) => (!total ? 0 : Math.round((part / total) * 1000) / 10);

      dataQuality = {
        totalRealItems: globalRealItems,
        gtinCoveragePct: pct(globalWithGtin, globalRealItems),
        skuCoveragePct: pct(globalWithSku, globalRealItems),
        costCoveragePct: pct(globalWithCost, globalRealItems),
        imageCoveragePct: pct(globalWithImage, globalRealItems),
        taxCoveragePct: pct(globalWithTax, globalRealItems),
      };

      let gtinsWithAnyMismatch = 0;
      let gtinsWithSpreadOver1 = 0;
      let gtinsWithSpreadOver3 = 0;

      for (const [, mm] of priceMinMaxByGtin) {
        if (mm.max > mm.min) {
          gtinsWithAnyMismatch++;
          const spread = mm.max - mm.min;
          if (spread >= 1) gtinsWithSpreadOver1++;
          if (spread >= 3) gtinsWithSpreadOver3++;
        }
      }

      pricing = { gtinsWithAnyMismatch, gtinsWithSpreadOver1, gtinsWithSpreadOver3 };
    }

    // ---------- 5) Render ----------
    res.render('reports', {
      merchants,
      lite,
      metrics: {
        totalMerchants,
        masterInventoryCount,
        merchantInventoryCount,
        gtinMetaCount,
        dataQuality,
        perMerchant,
        perMerchantLite,
        pricing,
      },
      syncRuns,
      activePage: 'reports',
      user: req.user || null,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error building reports page:', err);
    res.status(500).send('Error loading reports: ' + err.message);
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
app.get('/square/oauth/callback', requireLogin, async (req, res) => {
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

// Full nightly job: sync inventory from Square, then rebuild GTIN matrix
app.get('/tasks/full-nightly-sync', async (req, res) => {
  try {
    console.log('Nightly job: starting syncAllMerchants...');
    await syncAllMerchants();
    console.log('Nightly job: syncAllMerchants done. Starting runBuildGtinMatrix...');

    await runBuildGtinMatrix(); // uses defaults (all inventory)

    console.log('Nightly job: GTIN matrix rebuild done.');
    res.status(200).send('✅ Nightly sync + GTIN matrix rebuild completed');

    await firestore.collection('meta').doc('sync_status').set({
      last_full_sync_at: new Date().toISOString(),
      last_full_sync_run_id: runId,
    }, { merge: true });

  } catch (err) {
    console.error('Error in /tasks/full-nightly-sync', err);
    res.status(500).send('Nightly job failed: ' + (err.message || String(err)));
  }
});

// GTIN master dashboard (FAST shell render)
app.get('/dashboard-gtin', requireLogin, async (req, res) => {
  try {
    const merchantsSnap = await firestore.collection('merchants').get();
    const merchants = merchantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    res.render('dashboard_gtin', {
      merchants,
      pageTitle: 'Price Mismatch Dashboard',
      activePage: 'dashboard-gtin',  
      query: req.query
    });
  } catch (err) {
    console.error('Error loading /dashboard-gtin:', err);
    res.status(500).send('Failed to load page: ' + err.message);
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

// GET /api/gtin-meta?pageSize=50&cursor=...&q=...
app.get('/api/gtin-meta', requireLogin, async (req, res) => {
  try {
    const pageSize = Math.min(Number(req.query.pageSize) || 50, 500);
    const cursor = req.query.cursor || null;

    const qRaw = (req.query.q || '').trim();
    const q = qRaw.toLowerCase().replace(/\s+/g, ''); // ✅ normalize: "375 ml" -> "375ml"

    const colRef = firestore.collection('gtinMeta');

    // We will query by:
    // - exact GTIN (doc id) if digits and long
    // - prefix search on itemName_lc / vendorName_lc / sku_lc (if you store these)
    //
    // If you DON'T have *_lc fields yet, skip search mode and just do pagination.

    const isDigits = /^[0-9]+$/.test(q);

    let query = null;
    let cursorMode = 'docId'; // 'docId' or 'composite'

    if (q) {
      if (isDigits && q.length >= 8) {
        // fast exact docId lookup
        const doc = await colRef.doc(qRaw).get();
        if (!doc.exists) return res.json({ rows: [], nextCursor: null });

        return res.json({
          rows: [{ id: doc.id, ...doc.data() }],
          nextCursor: null,
        });
      }

      // Prefix search on itemName_lc (choose ONE field for indexing simplicity)
      // Make sure your documents store: itemName_lc = itemName.toLowerCase()
      query = colRef
        .orderBy('itemName_lc')
        .orderBy('__name__')
        .startAt(q)
        .endAt(q + '\uf8ff')
        .limit(pageSize);

      cursorMode = 'composite';
    } else {
      query = colRef.orderBy('__name__').limit(pageSize);
      cursorMode = 'docId';
    }

    // Apply cursor
    if (cursor) {
      if (cursorMode === 'docId') {
        const cursorDoc = await colRef.doc(cursor).get();
        if (cursorDoc.exists) query = query.startAfter(cursorDoc);
      } else {
        // base64: { v: <itemName_lc>, id: <docId> }
        let decoded = null;
        try {
          decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
        } catch {}
        if (decoded && typeof decoded.v === 'string' && typeof decoded.id === 'string') {
          query = query.startAfter(decoded.v, decoded.id);
        }
      }
    }

    const snap = await query.get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Next cursor
    let nextCursor = null;
    if (snap.size > 0) {
      const last = snap.docs[snap.docs.length - 1];
      if (cursorMode === 'docId') {
        nextCursor = last.id;
      } else {
        const v = (last.data().itemName_lc || '').toString();
        nextCursor = Buffer.from(JSON.stringify({ v, id: last.id }), 'utf8').toString('base64');
      }
    }

    res.json({ rows, nextCursor });
  } catch (err) {
    console.error('Error in /api/gtin-meta:', err);
    res.status(500).json({ error: err.message || 'Failed to load gtinMeta' });
  }
});


// PUT /api/gtin-meta/:gtin
app.put('/api/gtin-meta/:gtin', requireLogin, async (req, res) => {
  try {
    const gtin = (req.params.gtin || '').trim();
    if (!gtin) return res.status(400).json({ error: 'Missing gtin' });

    const sku = req.body.sku != null ? String(req.body.sku).trim() : null;
    const itemName = req.body.itemName != null ? String(req.body.itemName).trim() : null;
    const vendorName = req.body.vendorName != null ? String(req.body.vendorName).trim() : null;

    let unitCost = null;
    if (req.body.unitCost !== undefined) {
      unitCost = (req.body.unitCost === null || req.body.unitCost === '')
        ? null
        : Number(req.body.unitCost);
      if (unitCost !== null && Number.isNaN(unitCost)) {
        return res.status(400).json({ error: 'unitCost must be a number or null' });
      }
    }

    const nowIso = new Date().toISOString();

    // 1) Save GTIN meta (Firestore)
    const gtinMetaRef = firestore.collection('gtinMeta').doc(gtin);
    await gtinMetaRef.set({
      sku: sku || null,
      itemName: itemName || null,
      vendorName: vendorName || null,
      unitCost: unitCost,
      updatedAt: nowIso,
    }, { merge: true });

    // 2) Save canonical name (optional but useful for overlay)
    if (itemName) {
      await firestore.collection('item_master').doc(gtin).set({
        canonical_name: itemName,
        updated_at: nowIso,
      }, { merge: true });
    }

    // 3) Find all inventory docs for this GTIN (paginate to handle big sets)
    // We will:
    // - build merchant -> { itemIds, variationIds }
    // - update Firestore inventory docs with new sku/name fields
    const merchantToIds = new Map(); // merchantId -> { itemIds:Set, variationIds:Set }
    const invDocRefs = []; // store refs to update (master + merchant subcollection)
    const PAGE = 800;

    let last = null;
    while (true) {
      let q = firestore.collection('inventory')
        .where('gtin', '==', gtin)
        .orderBy('__name__')
        .limit(PAGE);

      if (last) q = q.startAfter(last);

      const snap = await q.get();
      if (snap.empty) break;

      snap.docs.forEach(doc => {
        const d = doc.data();
        const merchantId = d.merchant_id;
        const itemId = d.item_id;
        const variationId = d.variation_id;

        if (merchantId) {
          if (!merchantToIds.has(merchantId)) {
            merchantToIds.set(merchantId, { itemIds: new Set(), variationIds: new Set() });
          }
          const entry = merchantToIds.get(merchantId);
          if (itemId) entry.itemIds.add(itemId);
          if (variationId) entry.variationIds.add(variationId);
        }

        invDocRefs.push({ masterRef: doc.ref, merchantId: merchantId || null, docId: doc.id });
      });

      last = snap.docs[snap.docs.length - 1];
    }

    // 4) Update Square across all merchants that carry this GTIN
    // NOTE: vendorName/unitCost aren't pushed to Square (no native fields).
    let squareUpdatedItems = 0;
    let squareUpdatedVariations = 0;
    const squareErrors = [];

    for (const [merchantId, ids] of merchantToIds.entries()) {
      try {
        const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
        if (!merchantDoc.exists) continue;

        const merchant = merchantDoc.data();
        const client = createSquareClient(merchant.access_token, merchant.env || 'sandbox');

        // Update ITEM name once per itemId
        if (itemName) {
          for (const itemId of ids.itemIds) {
            try {
              const itemRes = await client.catalogApi.retrieveCatalogObject(itemId, true);
              const itemObj = itemRes.result.object;
              if (!itemObj || itemObj.type !== 'ITEM') continue;

              itemObj.itemData = itemObj.itemData || {};
              itemObj.itemData.name = itemName;

              await client.catalogApi.upsertCatalogObject({
                idempotencyKey: `meta-name-${merchantId}-${itemId}-${Date.now()}`,
                object: itemObj,
              });

              squareUpdatedItems++;
            } catch (e) {
              squareErrors.push({ merchantId, itemId, type: 'ITEM_NAME', error: e.message || String(e) });
            }
          }
        }

        // Update VARIATION sku (applied to every variation for this GTIN)
        if (sku) {
          for (const variationId of ids.variationIds) {
            try {
              const varRes = await client.catalogApi.retrieveCatalogObject(variationId, true);
              const varObj = varRes.result.object;
              if (!varObj || varObj.type !== 'ITEM_VARIATION') continue;

              varObj.itemVariationData = varObj.itemVariationData || {};
              varObj.itemVariationData.sku = sku;

              await client.catalogApi.upsertCatalogObject({
                idempotencyKey: `meta-sku-${merchantId}-${variationId}-${Date.now()}`,
                object: varObj,
              });

              squareUpdatedVariations++;
            } catch (e) {
              squareErrors.push({ merchantId, variationId, type: 'SKU', error: e.message || String(e) });
            }
          }
        }
      } catch (e) {
        squareErrors.push({ merchantId, type: 'MERCHANT', error: e.message || String(e) });
      }
    }

    // 5) Propagate to Firestore inventory docs (master + per-merchant mirror)
    // Do in batches to avoid 500 writes limit.
    let updatedInventoryDocs = 0;
    const chunkSize = 400;

    for (let i = 0; i < invDocRefs.length; i += chunkSize) {
      const slice = invDocRefs.slice(i, i + chunkSize);
      const batch = firestore.batch();

      slice.forEach(({ masterRef, merchantId, docId }) => {
        const patch = {
          updated_at: nowIso,
        };

        if (itemName != null) {
          patch.item_name = itemName;
          patch.item_name_lc = itemName.toLowerCase();
        }
        if (sku != null) patch.sku = sku;

        batch.set(masterRef, patch, { merge: true });

        if (merchantId) {
          const merchantInvRef = firestore.collection('merchants').doc(merchantId).collection('inventory').doc(docId);
          batch.set(merchantInvRef, patch, { merge: true });
        }

        updatedInventoryDocs++;
      });

      await batch.commit();
    }

    // Return updated meta doc
    const metaSnap = await gtinMetaRef.get();

    res.json({
      success: true,
      gtin,
      gtinMeta: { id: metaSnap.id, ...metaSnap.data() },
      affectedMerchants: merchantToIds.size,
      squareUpdatedItems,
      squareUpdatedVariations,
      updatedInventoryDocs,
      squareErrors: squareErrors.slice(0, 25), // prevent huge payloads
      squareErrorsCount: squareErrors.length,
      note: 'vendorName/unitCost saved in Firestore. SKU + Item Name pushed to Square.',
    });
  } catch (err) {
    console.error('Error updating gtin meta + square:', err);
    res.status(500).json({ error: err.message || 'Failed to update GTIN meta' });
  }
});


app.get('/dashboard-vendor-costs', requireLogin, async (req, res) => {
  const merchants = []; // or load like on other pages
  res.render('dashboard-vendor-costs', {
    merchants,
    pageTitle: 'Vendor & Unit Cost',
    currentView: 'vendorCosts',
    activePage: 'dashboard-vendor-costs',
    user: req.user || null,
  });
});

// GET /api/inventory?merchantId=...&pageSize=50&cursor=docId
app.get('/api/inventory', requireLogin, async (req, res) => {
  try {
    const merchantId = req.query.merchantId || null;
    const pageSize = Math.min(Number(req.query.pageSize) || 50, 500);
    const cursorRaw = req.query.cursor || null;

    const qRaw = (req.query.q || '').trim();
    const qNorm = qRaw.toLowerCase().replace(/\s+/g, ''); // "375 ml" -> "375ml"

    const colRef = merchantId
      ? firestore.collection('merchants').doc(merchantId).collection('inventory')
      : firestore.collection('inventory');

    // -----------------------------
    // Cursor decode (supports old docId cursors)
    // -----------------------------
    let cursor = null; // { m, id, v }
    if (cursorRaw) {
      try {
        const decoded = JSON.parse(Buffer.from(cursorRaw, 'base64').toString('utf8'));
        if (decoded && typeof decoded === 'object' && decoded.m && decoded.id) cursor = decoded;
      } catch {
        cursor = { m: 'doc', id: cursorRaw };
      }
    }

    // -----------------------------
    // Choose mode (or honor cursor mode)
    // -----------------------------
    const isDigitsNorm = /^[0-9]+$/.test(qNorm);
    const looksLikeToken = qNorm && qNorm.length <= 64; // "375ml", "750ml", "crownroyal", etc.

    let mode = cursor?.m || null;

    if (!qNorm) mode = 'doc';

    if (!mode) {
      if (isDigitsNorm && qNorm.length >= 8) mode = 'gtin';
      else if (looksLikeToken) mode = 'token';     // ✅ your new fast search
      else mode = 'item_prefix';                   // fallback for general text
    }

    // -----------------------------
    // Build query for a mode
    // -----------------------------
    const buildQuery = (m) => {
      if (m === 'gtin') {
        // preserve leading zeros; use normalized digits (spaces removed)
        return colRef.where('gtin', '==', qNorm).orderBy('__name__').limit(pageSize);
      }

      if (m === 'token') {
        // ✅ requires search_tokens: array-contains "375ml" / "50ml" etc.
        return colRef
          .where('search_tokens', 'array-contains', qNorm)
          .orderBy('__name__')
          .limit(pageSize);
      }

      if (m === 'item_prefix') {
        // Requires item_name_lc in docs
        return colRef
          .orderBy('item_name_lc')
          .orderBy('__name__')
          .startAt(qNorm)
          .endAt(qNorm + '\uf8ff')
          .limit(pageSize);
      }

      // default normal mode
      return colRef.orderBy('__name__').limit(pageSize);
    };

    // -----------------------------
    // Apply cursor
    // -----------------------------
    const applyCursor = async (query, m) => {
      if (!cursor || !cursor.id) return query;

      if (m === 'item_prefix') {
        if (typeof cursor.v === 'string') {
          return query.startAfter(cursor.v, cursor.id);
        }
        return query;
      }

      // doc/gtin/token pagination by doc snapshot (orderBy __name__)
      const snap = await colRef.doc(cursor.id).get();
      if (snap.exists) return query.startAfter(snap);
      return query;
    };

    // -----------------------------
    // Run query (fallback only on first page)
    // -----------------------------
    let query = buildQuery(mode);
    query = await applyCursor(query, mode);

    let snap = await query.get();

    // Optional fallback: if GTIN search returns nothing, try token search (page 1 only)
    if (!cursorRaw && qNorm && snap.empty && mode === 'gtin') {
      mode = 'token';
      snap = await buildQuery(mode).get();
    }

    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // -----------------------------
    // Next cursor (ALWAYS base64 JSON with mode)
    // -----------------------------
    let nextCursor = null;
    if (snap.size > 0) {
      const last = snap.docs[snap.docs.length - 1];

      if (mode === 'item_prefix') {
        const v = String(last.data().item_name_lc || '');
        nextCursor = Buffer.from(JSON.stringify({ m: 'item_prefix', v, id: last.id }), 'utf8').toString('base64');
      } else {
        nextCursor = Buffer.from(JSON.stringify({ m: mode, id: last.id }), 'utf8').toString('base64');
      }
    }

    res.json({ rows, nextCursor, mode });
  } catch (err) {
    console.error('Error in /api/inventory:', err);
    res.status(500).json({ error: err.message || 'Internal error loading inventory' });
  }
});

app.get('/api/gtin-matrix', requireLogin, async (req, res) => {
  try {
    const pageSize = Math.min(Number(req.query.pageSize) || 50, 250);
    const cursor = req.query.cursor || null;

    const qRaw = (req.query.q || '').trim().toLowerCase();
    const qNoSpace = qRaw.replace(/\s+/g, '');      // "200 ml" -> "200ml"
    const hasQuery = !!qRaw;
    const isDigits = /^[0-9]+$/.test(qNoSpace);     // pure digits (for GTIN search)

    const colRef = firestore.collection('gtin_matrix');

    let query;
    let cursorMode = 'docId'; // 'docId' | 'scan'

    if (hasQuery) {
      if (isDigits && qNoSpace.length >= 8) {
        // ✅ GTIN-style search: use document ID (we assume docId = GTIN)
        query = colRef
          .orderBy('__name__')
          .startAt(qNoSpace)
          .endAt(qNoSpace)
          .limit(pageSize);
        cursorMode = 'docId';
      } else {
        // ✅ Name / size / SKU search (e.g. "tito", "200ml", "200 ml")
        // Firestore can't do substring matches, so we scan in batches
        cursorMode = 'scan';
      }
    } else {
      // No search term: just paginate by docId
      query = colRef.orderBy('__name__').limit(pageSize);
      cursorMode = 'docId';
    }

    // Load locations once
    const locSnap = await firestore.collection('location_index').get();
    const locations = locSnap.docs
      .map(d => d.data()?.locKey)
      .filter(Boolean)
      .sort();

    // ---------- SCAN MODE (substring search for things like "200ml") ----------
    if (cursorMode === 'scan') {
      const matchNorm = qNoSpace; // normalized search text

      const collected = [];
      const batchSize = 400; // Firestore read batch
      let lastId = cursor || null;
      let lastSnap = null;
      let reachedLimit = false;

      while (!reachedLimit) {
        let qBatch = colRef.orderBy('__name__').limit(batchSize);
        if (lastId) {
          const cursorDoc = await colRef.doc(lastId).get();
          if (cursorDoc.exists) {
            qBatch = qBatch.startAfter(cursorDoc);
          }
        }

        const snap = await qBatch.get();
        lastSnap = snap;
        if (snap.empty) break;

        for (const doc of snap.docs) {
          lastId = doc.id;
          const d = doc.data();

          const nameNorm = (d.item_name_lc || d.item_name || '')
            .toString()
            .toLowerCase()
            .replace(/\s+/g, '');
          const skuNorm = (d.sku || '')
            .toString()
            .toLowerCase()
            .replace(/\s+/g, '');

          // ✅ substring match in normalized name or SKU
          if (!matchNorm || nameNorm.includes(matchNorm) || skuNorm.includes(matchNorm)) {
            collected.push({ gtin: doc.id, ...d });
            if (collected.length >= pageSize) {
              reachedLimit = true;
              break;
            }
          }
        }

        // No more docs to scan
        if (snap.size < batchSize) break;
      }

      const rows = collected;
      let nextCursor = null;

      // If we scanned a full batch and hit the page limit, expose cursor for "Next"
      if (lastSnap && lastSnap.size === batchSize && lastId && rows.length >= pageSize) {
        nextCursor = lastId;
      }

      return res.json({ rows, locations, nextCursor });
    }

    // ---------- DOC-ID MODE (GTIN or no search) ----------
    if (cursor && cursorMode === 'docId') {
      const cursorDoc = await colRef.doc(cursor).get();
      if (cursorDoc.exists) {
        query = query.startAfter(cursorDoc);
      }
    }

    const snap = await query.get();
    const rows = snap.docs.map(d => ({ gtin: d.id, ...d.data() }));

    let nextCursor = null;
    if (snap.size > 0) {
      const last = snap.docs[snap.docs.length - 1];
      nextCursor = last.id;
    }

    res.json({ rows, locations, nextCursor });
  } catch (err) {
    console.error('Error in /api/gtin-matrix:', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});


// Duplicate GTINs page + API
app.get('/duplicates-gtin', requireLogin, async (req, res) => {
  try {
    const merchantsSnap = await firestore.collection('merchants').get();
    const merchants = merchantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    res.render('duplicates_gtin', {
      merchants,
      pageTitle: 'Duplicate GTINs',
      activePage: 'duplicates-gtin',
    });
  } catch (err) {
    console.error('Error loading duplicates page:', err);
    res.status(500).send('Failed to load duplicates page: ' + err.message);
  }
});

// Data API
app.get('/api/gtin-duplicates', requireLogin, async (req, res) => {
  try {
    const merchantId = (req.query.merchantId || '').trim();
    const mode = (req.query.mode || 'gtin').trim(); // 'gtin' or 'gtin_location'
    const top = Math.min(Number(req.query.top) || 200, 2000);

    if (!merchantId) {
      return res.status(400).json({ error: 'merchantId is required' });
    }

    const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
    if (!merchantDoc.exists) {
      return res.status(404).json({ error: `Merchant ${merchantId} not found` });
    }

    const invRef = firestore.collection('merchants').doc(merchantId).collection('inventory');

    // Scan in pages (safe for 30K+)
    const PAGE = 1000;
    let lastDoc = null;

    const counts = new Map();     // key -> count
    const samples = new Map();    // key -> sample row (name/sku/category/location)
    let totalDocs = 0;
    let withGtin = 0;

    while (true) {
      let q = invRef.orderBy('__name__').limit(PAGE);
      if (lastDoc) q = q.startAfter(lastDoc);

      const snap = await q.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        totalDocs++;
        const d = doc.data();
        const gtin = (d.gtin || '').toString().trim();
        if (!gtin) continue;

        withGtin++;

        const locationId = (d.location_id || '').toString().trim();
        const key =
          mode === 'gtin_location'
            ? `${gtin}|${locationId || 'NO_LOCATION'}`
            : gtin;

        counts.set(key, (counts.get(key) || 0) + 1);

        if (!samples.has(key)) {
          samples.set(key, {
            gtin,
            location_id: locationId || '',
            location_name: d.location_name || '',
            item_name: d.item_name || '',
            sku: d.sku || '',
            category_name: d.category_name || '',
          });
        }
      }

      lastDoc = snap.docs[snap.docs.length - 1];
    }

    const dupes = Array.from(counts.entries())
      .filter(([, c]) => c > 1)
      .map(([key, c]) => {
        const s = samples.get(key) || {};
        let gtin = s.gtin || key;
        let location_id = s.location_id || '';
        if (mode === 'gtin_location') {
          const parts = key.split('|');
          gtin = parts[0] || gtin;
          location_id = parts[1] || location_id;
        }
        return {
          key,
          gtin,
          location_id,
          location_name: s.location_name || '',
          count: c,
          item_name: s.item_name || '',
          sku: s.sku || '',
          category_name: s.category_name || '',
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, top);

    res.json({
      merchantId,
      merchantName: merchantDoc.data()?.business_name || merchantId,
      mode,
      totalDocs,
      withGtin,
      duplicateKeys: Array.from(counts.values()).filter(v => v > 1).length,
      dupes,
    });
  } catch (err) {
    console.error('Error in /api/gtin-duplicates:', err);
    res.status(500).json({ error: err.message || 'Failed to compute duplicates' });
  }
});

// Delete from Square + Firestore (variation by default)
app.post('/api/delete-item', requireLogin, async (req, res) => {
  try {
    const { merchantId, variationId, itemId, mode } = req.body || {};
    // mode: 'variation' (default) or 'item'

    if (!merchantId) return res.status(400).json({ error: 'merchantId is required' });
    if (mode === 'item') {
      if (!itemId) return res.status(400).json({ error: 'itemId is required for mode=item' });
    } else {
      if (!variationId) return res.status(400).json({ error: 'variationId is required for mode=variation' });
    }

    // 1) Load merchant token
    const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
    if (!merchantDoc.exists) return res.status(404).json({ error: 'Merchant not found' });

    const merchant = merchantDoc.data();
    const client = createSquareClient(merchant.access_token, merchant.env || 'sandbox');

    // 2) Delete in Square
    const squareObjectId = (mode === 'item') ? itemId : variationId;

    // NOTE: In Square, delete is irreversible. Consider archive if you want safety.
    await client.catalogApi.deleteCatalogObject(squareObjectId);

    // 3) Delete in Firestore (master + per-merchant)
    const BATCH_SIZE = 400;

    async function deleteQueryInBatches(baseQuery) {
      let deleted = 0;
      let query = baseQuery.orderBy('__name__');

      while (true) {
        const snap = await query.limit(BATCH_SIZE).get();
        if (snap.empty) break;

        const batch = firestore.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();

        deleted += snap.size;
        query = baseQuery.orderBy('__name__').startAfter(snap.docs[snap.docs.length - 1]);
      }

      return deleted;
    }

    // master inventory deletes
    let masterQuery = firestore.collection('inventory').where('merchant_id', '==', merchantId);
    // merchant subcollection deletes
    let merchantQuery = firestore.collection('merchants').doc(merchantId).collection('inventory');

    if (mode === 'item') {
      masterQuery = masterQuery.where('item_id', '==', itemId);
      merchantQuery = merchantQuery.where('item_id', '==', itemId);
    } else {
      masterQuery = masterQuery.where('variation_id', '==', variationId);
      merchantQuery = merchantQuery.where('variation_id', '==', variationId);
    }

    const deletedMaster = await deleteQueryInBatches(masterQuery);
    const deletedMerchant = await deleteQueryInBatches(merchantQuery);

    return res.json({
      success: true,
      mode: mode || 'variation',
      squareDeletedObjectId: squareObjectId,
      deletedMaster,
      deletedMerchant,
    });
  } catch (err) {
    console.error('Error in /api/delete-item:', err);
    return res.status(500).json({ error: err.message || 'Failed to delete item' });
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

