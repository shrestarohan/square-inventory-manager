// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;

module.exports = function buildAuthRouter({ firestore, passport }) {
  const router = express.Router();

  // -----------------------------
  // Configure strategies (moved from app.js)
  // -----------------------------

  const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
    .split(';')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

  // Google OAuth
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL,
      },
      (accessToken, refreshToken, profile, done) => {
        try {
          const email = (profile.emails?.[0]?.value || '').toLowerCase();

          if (!email) return done(null, false, { message: 'No email returned from Google.' });

          // If list is configured, enforce it
          if (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(email)) {
            return done(null, false, { message: 'Your Google account is not allowed to access this app.' });
          }

          return done(null, { id: profile.id, email });
        } catch (e) {
          return done(e);
        }
      }
    )
  );

  // Local username/password
  passport.use(new LocalStrategy(
    { usernameField: 'username', passwordField: 'password' },
    async (username, password, done) => {
      try {
        const input = (username || '').trim().toLowerCase();
        if (!input) return done(null, false, { message: 'Invalid username or password' });

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

        const data = doc.data() || {};
        const ok = await bcrypt.compare(password, data.passwordHash || '');
        if (!ok) return done(null, false, { message: 'Invalid username or password' });

        return done(null, {
          id: doc.id,
          email: data.email || doc.id,
          username: data.username || null,
          role: data.role || 'user',
        });
      } catch (e) {
        return done(e);
      }
    }
  ));

  // Session serialization
  passport.serializeUser((user, done) => {
    done(null, { id: user.id, email: user.email });
  });

  passport.deserializeUser((obj, done) => {
    done(null, obj);
  });

  // -----------------------------
  // Routes
  // -----------------------------

  // Login screen
  router.get('/login', (req, res) => {
    if (req.isAuthenticated && req.isAuthenticated()) return res.redirect('/dashboard');

    res.render('login', {
      next: req.query.next || '/dashboard',
      error: req.query.error || null,
    });
  });

  // Local login
  router.post('/login', (req, res, next) => {
    const nextUrl = req.body.next || '/dashboard';

    passport.authenticate('local', (err, user, info) => {
      if (err) return next(err);
      if (!user) {
        const msg = info?.message || 'Login failed';
        return res.redirect(`/login?error=${encodeURIComponent(msg)}&next=${encodeURIComponent(nextUrl)}`);
      }

      req.logIn(user, (e) => {
        if (e) return next(e);

        // remember me (optional)
        if (req.body.remember) {
          req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 14; // 14 days
        }

        return res.redirect(nextUrl);
      });
    })(req, res, next);
  });

  // Google SSO (pass next via state)
  router.get('/auth/google', (req, res, next) => {
    const nextUrl = req.query.next || '/dashboard';
    passport.authenticate('google', {
      scope: ['profile', 'email'],
      prompt: 'select_account',
      state: encodeURIComponent(nextUrl),
    })(req, res, next);
  });

  // Google callback
  router.get('/auth/google/callback',
    passport.authenticate('google', {
      failureRedirect: '/login?error=' + encodeURIComponent('Your Google account is not allowed to access this app.'),
    }),
    (req, res) => {
      const nextUrl = req.query.state ? decodeURIComponent(req.query.state) : '/dashboard';
      req.session.save(() => res.redirect(nextUrl));
    }
  );

  // Logout
  router.post('/logout', (req, res, next) => {
    req.logout(err => {
      if (err) return next(err);
      req.session?.destroy(() => res.redirect('/login'));
    });
  });

  return router;
};
