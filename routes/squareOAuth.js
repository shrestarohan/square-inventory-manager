// routes/squareOAuth.js
const express = require('express');

module.exports = function buildSquareOAuthRouter({
  firestore,
  requireLogin,
  squareOAuthClient,
  createSquareClient, // not required here but kept for parity
  squareEnv,
}) {
  const router = express.Router();

  const SQUARE_APP_ID = process.env.SQUARE_APP_ID;
  const SQUARE_APP_SECRET = process.env.SQUARE_APP_SECRET;

  const REDIRECT_URI =
    process.env.SQUARE_REDIRECT_URI ||
    process.env.SQUARE_REDIRECT_URI_PROD ||
    process.env.SQUARE_REDIRECT_URI_DEV ||
    '';

  // --- 1) Start Square OAuth – connect a new Square business ---
  router.get('/connect-square', requireLogin, (req, res) => {
    if (!SQUARE_APP_ID) return res.status(500).send('SQUARE_APP_ID is not configured');
    if (!REDIRECT_URI) return res.status(500).send('SQUARE_REDIRECT_URI is not configured');

    const state = 'csrf-or-user-id'; // you can improve later

    const scopes = [
      'MERCHANT_PROFILE_READ',
      'ITEMS_READ',
      'ITEMS_WRITE',
      'INVENTORY_READ',
      'INVENTORY_WRITE',
      'ORDERS_READ',
    ].join(' ');

    const authBase =
      squareEnv === 'sandbox'
        ? 'https://connect.squareupsandbox.com/oauth2/authorize'
        : 'https://connect.squareup.com/oauth2/authorize';

    const url =
      `${authBase}?client_id=${encodeURIComponent(SQUARE_APP_ID)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&session=false` +
      `&state=${encodeURIComponent(state)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

    return res.redirect(url);
  });

  // --- 2) OAuth callback – exchange code for tokens, store merchant in Firestore ---
  router.get('/square/oauth/callback', requireLogin, async (req, res) => {
    const { code, error, error_description } = req.query;

    if (error) {
      console.error('Square returned error:', error, error_description);
      return res.status(400).send(`Square OAuth error: ${error} – ${error_description || ''}`);
    }

    if (!code) return res.status(400).send('Missing authorization code');
    if (!SQUARE_APP_ID || !SQUARE_APP_SECRET) {
      return res.status(500).send('SQUARE_APP_ID / SQUARE_APP_SECRET not configured');
    }
    if (!REDIRECT_URI) return res.status(500).send('SQUARE_REDIRECT_URI is not configured');

    try {
      const { result } = await squareOAuthClient.oAuthApi.obtainToken({
        clientId: SQUARE_APP_ID,
        clientSecret: SQUARE_APP_SECRET,
        code,
        grantType: 'authorization_code',
        redirectUri: REDIRECT_URI,
      });

      const { accessToken, refreshToken, merchantId } = result;

      // Use merchant token to retrieve merchant profile (business name)
      const merchantClient = createSquareClient(accessToken, squareEnv);
      const merchantRes = await merchantClient.merchantsApi.retrieveMerchant(merchantId);

      const merchant = merchantRes?.result?.merchant;

      await firestore.collection('merchants').doc(merchantId).set(
        {
          merchant_id: merchantId,
          business_name: merchant?.businessName || merchantId,
          access_token: accessToken,
          refresh_token: refreshToken || null,
          env: squareEnv,
          connected_at: new Date().toISOString(),
        },
        { merge: true }
      );

      return res.send(
        `Square business connected successfully for merchant "${merchant?.businessName || merchantId}". You can close this window.`
      );
    } catch (err) {
      console.error('OAuth error', err);

      let details = '';
      try {
        if (err?.errors) details = JSON.stringify(err.errors, null, 2);
        else if (err?.body) details = JSON.stringify(err.body, null, 2);
        else details = JSON.stringify(err, null, 2);
      } catch {
        details = String(err);
      }

      return res.status(500).send(
        `<h2>OAuth error from Square</h2>` +
          `<p><strong>Message:</strong> ${err.message || 'No message'}</p>` +
          `<pre>${details}</pre>`
      );
    }
  });

  return router;
};
