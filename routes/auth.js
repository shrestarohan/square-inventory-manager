// routes/auth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const LocalStrategy = require("passport-local").Strategy;
const GoogleStrategy = require("passport-google-oauth20").Strategy;

/**
 * Firestore auth policy doc:
 *   settings/auth
 * {
 *   mode: "allowlist" | "domain" | "both",
 *   allowlist_emails: ["a@b.com", ...],
 *   allowlist_domains: ["yourdomain.com", ...],
 *   admins: ["admin@b.com", ...],
 *   updated_at, updated_by
 * }
 *
 * Bootstrap fallbacks:
 * - SUPER_ADMIN_EMAILS="you@gmail.com;other@gmail.com" (always admin)
 * - ALLOWED_EMAILS="..." only used if Firestore doc missing/empty (optional migration bridge)
 */

const POLICY_CACHE_TTL_MS = 30_000;
let _policyCache = { ts: 0, data: null };

function normEmail(s) {
  return String(s || "").trim().toLowerCase();
}
function normDomain(s) {
  return String(s || "").trim().toLowerCase();
}
function emailDomain(email) {
  const e = normEmail(email);
  const at = e.indexOf("@");
  return at > -1 ? e.slice(at + 1) : "";
}

function envList(name) {
  return (process.env[name] || "")
    .split(";")
    .map((x) => String(x || "").trim().toLowerCase())
    .filter(Boolean);
}

const SUPER_ADMIN_EMAILS = envList("SUPER_ADMIN_EMAILS");
const ENV_ALLOWED_EMAILS = envList("ALLOWED_EMAILS"); // migration bridge only

async function loadAuthPolicy(firestore) {
  const now = Date.now();
  if (_policyCache.data && now - _policyCache.ts < POLICY_CACHE_TTL_MS) {
    return _policyCache.data;
  }

  let doc = null;
  try {
    const snap = await firestore.collection("settings").doc("auth").get();
    if (snap.exists) doc = snap.data() || {};
  } catch {
    doc = null;
  }

  const policy = {
    // defaults
    mode: "allowlist",
    allowlist_emails: [],
    allowlist_domains: [],
    admins: [],

    // markers
    _hasFirestoreDoc: !!doc,
  };

  if (doc) {
    policy.mode = String(doc.mode || "allowlist").toLowerCase();
    policy.allowlist_emails = Array.isArray(doc.allowlist_emails)
      ? doc.allowlist_emails.map(normEmail).filter(Boolean)
      : [];
    policy.allowlist_domains = Array.isArray(doc.allowlist_domains)
      ? doc.allowlist_domains.map(normDomain).filter(Boolean)
      : [];
    policy.admins = Array.isArray(doc.admins) ? doc.admins.map(normEmail).filter(Boolean) : [];
  }

  // Cache it
  _policyCache = { ts: now, data: policy };
  return policy;
}

function isAdminEmail(policy, email) {
  const e = normEmail(email);
  if (!e) return false;
  if (SUPER_ADMIN_EMAILS.includes(e)) return true; // bootstrap / break-glass
  return Array.isArray(policy?.admins) && policy.admins.includes(e);
}

function isAllowedByPolicy(policy, email) {
  const e = normEmail(email);
  if (!e) return false;

  const mode = String(policy?.mode || "allowlist").toLowerCase();
  const domain = emailDomain(e);

  const inEmails = Array.isArray(policy?.allowlist_emails) && policy.allowlist_emails.includes(e);
  const inDomains = Array.isArray(policy?.allowlist_domains) && policy.allowlist_domains.includes(domain);

  if (mode === "domain") return inDomains;
  if (mode === "both") return inEmails || inDomains;
  return inEmails; // allowlist
}

function isAllowedEmail({ policy, email }) {
  const e = normEmail(email);
  if (!e) return false;

  // ✅ SUPER admins ALWAYS allowed (break-glass)
  if (SUPER_ADMIN_EMAILS.includes(e)) return true;

  // 1) If Firestore policy exists and has any allow rule configured, enforce it
  const hasFsRules =
    (policy?._hasFirestoreDoc && (policy.allowlist_emails?.length || policy.allowlist_domains?.length)) || false;

  if (hasFsRules) return isAllowedByPolicy(policy, e);

  // 2) Migration bridge: if ENV allowlist exists, enforce it
  if (ENV_ALLOWED_EMAILS.length) return ENV_ALLOWED_EMAILS.includes(e);

  // 3) Otherwise allow anyone with Google SSO (not recommended, but avoids lockout)
  return true;
}

function requireAdmin({ firestore }) {
  return async function (req, res, next) {
    try {
      const email = normEmail(req.user?.email || "");
      const policy = await loadAuthPolicy(firestore);

      if (!email || !isAdminEmail(policy, email)) {
        return res.status(403).send("Forbidden");
      }
      return next();
    } catch (e) {
      return res.status(500).send("Admin check failed");
    }
  };
}

// Simple validator for admin edits
function parseLinesToArray(text) {
  return String(text || "")
    .split(/\r?\n|,|;/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function validatePolicyInput(body) {
  const mode = String(body.mode || "allowlist").toLowerCase();
  const allowEmails = Array.isArray(body.allowlist_emails)
    ? body.allowlist_emails
    : parseLinesToArray(body.allowlist_emails_text);
  const allowDomains = Array.isArray(body.allowlist_domains)
    ? body.allowlist_domains
    : parseLinesToArray(body.allowlist_domains_text);
  const admins = Array.isArray(body.admins) ? body.admins : parseLinesToArray(body.admins_text);

  const clean = {
    mode: ["allowlist", "domain", "both"].includes(mode) ? mode : "allowlist",
    allowlist_emails: allowEmails.map(normEmail).filter(Boolean),
    allowlist_domains: allowDomains.map(normDomain).filter(Boolean),
    admins: admins.map(normEmail).filter(Boolean),
  };

  // Prevent lockout: must have at least one admin between Firestore admins or SUPER_ADMIN_EMAILS
  const effectiveAdmins = new Set([...(clean.admins || []), ...SUPER_ADMIN_EMAILS]);
  if (effectiveAdmins.size === 0) {
    return { ok: false, error: "You must have at least one admin (or set SUPER_ADMIN_EMAILS in env)." };
  }

  return { ok: true, clean };
}

module.exports = function buildAuthRouter({ firestore, passport }) {
  const router = express.Router();

  // -----------------------------
  // Google OAuth
  // -----------------------------
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL,
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const email = normEmail(profile.emails?.[0]?.value || "");
          if (!email) return done(null, false, { message: "No email returned from Google." });

          const policy = await loadAuthPolicy(firestore);

          // ✅ DEBUG (TEMP)
          console.log("GOOGLE email:", email);
          console.log("SUPER_ADMIN_EMAILS:", SUPER_ADMIN_EMAILS);
          console.log("ENV_ALLOWED_EMAILS:", ENV_ALLOWED_EMAILS);
          console.log("policy:", {
            mode: policy?.mode,
            allowlist_emails: policy?.allowlist_emails,
            allowlist_domains: policy?.allowlist_domains,
            admins: policy?.admins,
            _hasFirestoreDoc: policy?._hasFirestoreDoc,
          });
          
          if (!isAllowedEmail({ policy, email })) {
            return done(null, false, { message: "Your Google account is not allowed to access this app." });
          }

          return done(null, { id: profile.id, email });
        } catch (e) {
          return done(e);
        }
      }
    )
  );

  // -----------------------------
  // Local username/password
  // -----------------------------
  passport.use(
    new LocalStrategy({ usernameField: "username", passwordField: "password" }, async (username, password, done) => {
      try {
        const input = normEmail(username);
        if (!input) return done(null, false, { message: "Invalid username or password" });

        // Option A: doc id is the email
        let doc = await firestore.collection("users").doc(input).get();

        // Option B: lookup by username field
        if (!doc.exists) {
          const snap = await firestore.collection("users").where("username", "==", input).limit(1).get();
          if (!snap.empty) doc = snap.docs[0];
        }

        if (!doc.exists) return done(null, false, { message: "Invalid username or password" });

        const data = doc.data() || {};
        if (data.enabled === false) return done(null, false, { message: 'Account disabled' });
        const ok = await bcrypt.compare(password, data.passwordHash || "");
        if (!ok) return done(null, false, { message: "Invalid username or password" });

        return done(null, {
          id: doc.id,
          email: data.email || doc.id,
          username: data.username || null,
          role: data.role || "user",
        });
      } catch (e) {
        return done(e);
      }
    })
  );

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
  router.get("/login", (req, res) => {
    if (req.isAuthenticated && req.isAuthenticated()) return res.redirect("/dashboard");

    res.render("login", {
      next: req.query.next || "/dashboard",
      error: req.query.error || null,
    });
  });

  // Local login
  router.post("/login", (req, res, next) => {
    const nextUrl = req.body.next || "/dashboard";

    passport.authenticate("local", (err, user, info) => {
      if (err) return next(err);
      if (!user) {
        const msg = info?.message || "Login failed";
        return res.redirect(`/login?error=${encodeURIComponent(msg)}&next=${encodeURIComponent(nextUrl)}`);
      }

      req.logIn(user, (e) => {
        if (e) return next(e);

        if (req.body.remember) {
          req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 14; // 14 days
        }
        return res.redirect(nextUrl);
      });
    })(req, res, next);
  });

  // Google SSO (pass next via state)
  router.get("/auth/google", (req, res, next) => {
    const nextUrl = req.query.next || "/dashboard";
    passport.authenticate("google", {
      scope: ["profile", "email"],
      prompt: "select_account",
      state: encodeURIComponent(nextUrl),
    })(req, res, next);
  });

  // Google callback (custom callback so we can show info.message)
  router.get("/auth/google/callback", (req, res, next) => {
    passport.authenticate("google", (err, user, info) => {
      if (err) return next(err);

      if (!user) {
        const msg = info?.message || "Google login failed";
        const nextUrl = req.query.state ? decodeURIComponent(req.query.state) : "/dashboard";
        return res.redirect(`/login?error=${encodeURIComponent(msg)}&next=${encodeURIComponent(nextUrl)}`);
      }

      req.logIn(user, (e) => {
        if (e) return next(e);
        const nextUrl = req.query.state ? decodeURIComponent(req.query.state) : "/dashboard";
        req.session.save(() => res.redirect(nextUrl));
      });
    })(req, res, next);
  });

  // Logout
  router.post("/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session?.destroy(() => res.redirect("/login"));
    });
  });

  // -----------------------------
  // Admin UI + API to manage Google SSO allowlist
  // -----------------------------
  // Admin page
  router.get("/admin/auth", (req, res, next) => {
    if (!(req.isAuthenticated && req.isAuthenticated())) return res.redirect("/login?next=/admin/auth");
    return requireAdmin({ firestore })(req, res, async () => {
      const policy = await loadAuthPolicy(firestore);

      res.render("admin-auth", {
        policy,
        superAdmins: SUPER_ADMIN_EMAILS,
      });
    });
  });

  // Read policy
  router.get("/api/admin/auth", (req, res, next) => {
    if (!(req.isAuthenticated && req.isAuthenticated())) return res.status(401).json({ success: false, error: "Unauthorized" });
    return requireAdmin({ firestore })(req, res, async () => {
      const snap = await firestore.collection("settings").doc("auth").get();
      const data = snap.exists ? snap.data() || {} : {};
      res.json({ success: true, data, superAdmins: SUPER_ADMIN_EMAILS });
    });
  });

  // Update policy
  router.put("/api/admin/auth", express.json({ limit: "256kb" }), (req, res, next) => {
    if (!(req.isAuthenticated && req.isAuthenticated())) return res.status(401).json({ success: false, error: "Unauthorized" });

    return requireAdmin({ firestore })(req, res, async () => {
      const v = validatePolicyInput(req.body || {});
      if (!v.ok) return res.status(400).json({ success: false, error: v.error });

      const clean = v.clean;

      await firestore.collection("settings").doc("auth").set(
        {
          ...clean,
          updated_at: new Date().toISOString(),
          updated_by: normEmail(req.user?.email || ""),
        },
        { merge: true }
      );

      // Bust cache so changes apply immediately
      _policyCache = { ts: 0, data: null };

      res.json({ success: true });
    });
  });

  return router;
};
