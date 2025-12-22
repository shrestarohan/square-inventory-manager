// app.js
require("./lib/loadEnv"); // adjust relative path

const path = require("path");
const express = require('express');
const session = require('express-session');
const passport = require('passport');

const firestore = require('./lib/firestore');
const appContext = require('./middleware/appContext');
const requireLogin = require('./middleware/requireLogin');

const { createSquareOAuthClient, createSquareClient, makeCreateSquareClientForMerchant } = require('./lib/square');
const createSquareClientForMerchant = makeCreateSquareClientForMerchant({ firestore });

// (Optional) pull these once so you don't "require()" inside app.use()
const { syncAllMerchants } = require('./lib/inventorySync');
const { runBuildGtinMatrix } = require('./scripts/buildGtinMatrix');

const app = express();

// -----------------------------
// Core middleware
// -----------------------------

// (optional) request logging
app.use((req, res, next) => {
  console.log('REQ:', req.method, req.originalUrl);
  next();
});

// Behind Cloud Run / proxy
app.set('trust proxy', 1);

// Parse JSON + forms
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// static files
app.use(express.static(path.join(__dirname, 'public')));

// -----------------------------
// Sessions + Passport
// -----------------------------
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-session-secret-change-me',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: { secure: 'auto', sameSite: 'lax' },
}));

// Passport init (strategies are configured in routes/auth.js)
app.use(passport.initialize());
app.use(passport.session());

// -----------------------------
// Views
// -----------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Shared locals (env + user + syncStatus)
app.use(appContext({ firestore }));

// -----------------------------
// Square clients used by routers
// -----------------------------
const SQUARE_ENV = process.env.SQUARE_ENV || 'sandbox';
const squareOAuthClient = createSquareOAuthClient(SQUARE_ENV);

// -----------------------------
// Routers
// -----------------------------

// Auth (login / google / logout) + passport strategies
app.use(require('./routes/auth')({ firestore, passport }));

// Square connect flow (connect-square + callback)
app.use(require('./routes/squareOAuth')({
  firestore,
  requireLogin,
  squareOAuthClient,
  createSquareClient,
  squareEnv: SQUARE_ENV,
}));

// Tasks (sync endpoints)
// NOTE: choose one of these patterns:
//
// ✅ Option A: protect tasks with login (simple for now)
// app.use(requireLogin, require('./routes/tasks')({ firestore, syncAllMerchants, runBuildGtinMatrix }));
//
// ✅ Option B: leave tasks unprotected (NOT recommended)
// app.use(require('./routes/tasks')({ firestore, syncAllMerchants, runBuildGtinMatrix }));
//
// ✅ Option C: protect tasks with a header secret (best for Cloud Scheduler)
// keep tasks unprotected from login, but enforce a secret in the router.
//

app.get("/healthz", (req, res) => res.status(200).send("ok"));

app.use(require('./routes/tasks')({
  firestore,
  syncAllMerchants,
  runBuildGtinMatrix,
  requireLogin, // if your tasks router wants to use it for some routes
}));

// -----------------------------
// APIs (shared across multiple views)
// -----------------------------
app.use(require('./routes/apiUpdates')({
  firestore,
  requireLogin,
  createSquareClient,
}));

app.use(require('./routes/inventory')({
  firestore,
  requireLogin,
}));

app.use(require('./routes/gtinMeta')({
  firestore,
  requireLogin,
  createSquareClient,
}));

app.use(require('./routes/gtinDuplicates')({
  firestore,
  requireLogin,
}));

// Consolidated GTIN matrix API (price mismatch view)
app.use(require('./routes/gtinInventoryMatrixConsolidated')({
  firestore,
  requireLogin,
}));

// If you still use per-merchant GTIN matrix docs somewhere:
app.use(require('./routes/gtinMatrix')({
  firestore,
  requireLogin,
}));

app.use('/api', require('./routes/inventoryIntegrityRoutes')({
  firestore,
  requireLogin,
  createSquareClient,
}));

app.use('/api', require('./routes/deleteGtin')({
  firestore,
  requireLogin,
  createSquareClient: createSquareClientForMerchant,
}));

const buildItemImagesRouter = require('./routes/itemImages');
app.use(buildItemImagesRouter({ firestore, requireLogin }));

// AI Agent routes
app.use('/api/ai', require('./routes/aiAgent'));

// -----------------------------
// Pages (all res.render routes)
// -----------------------------
app.use(require('./routes/indexPages')({
  firestore,
  requireLogin,
}));

// Home
app.get('/', (req, res) => res.redirect('/login'));

// (optional) env debug
app.get('/debug/env', (req, res) => {
  res.json({
    nodeEnv: process.env.NODE_ENV || null,
    appEnv: process.env.APP_ENV || null,
    squareEnv: process.env.SQUARE_ENV || 'sandbox',
    hasSessionSecret: !!process.env.SESSION_SECRET,
    hasGoogleClientId: !!process.env.GOOGLE_CLIENT_ID,
    hasGoogleClientSecret: !!process.env.GOOGLE_CLIENT_SECRET,
    googleCallbackUrl: process.env.GOOGLE_CALLBACK_URL || null,
    allowedEmails: (process.env.ALLOWED_EMAILS || '').split(';').filter(Boolean),
  });
});

// -----------------------------
// Global error handler (helps Cloud Run debugging)
// -----------------------------
app.use((err, req, res, next) => {
  console.error('UNHANDLED ERROR:', err);
  res.status(500).send('Internal Server Error');
});

// Only start server if run directly (node app.js / nodemon app.js)
if (require.main === module) {
  const port = process.env.PORT || 8080;
  app.listen(port, () => console.log(`Dev server listening on port ${port}`));
}

module.exports = app;
