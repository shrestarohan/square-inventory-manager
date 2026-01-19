// middleware/appContext.js
module.exports = function buildAppContext({ firestore }) {
  // tiny in-memory cache (per instance)
  const ADMIN_CACHE_TTL_MS = 30_000;
  let _adminCache = { ts: 0, admins: [] };

  function normEmail(s) {
    return String(s || "").trim().toLowerCase();
  }

  function envList(name) {
    return (process.env[name] || "")
      .split(";")
      .map((x) => String(x || "").trim().toLowerCase())
      .filter(Boolean);
  }

  const SUPER_ADMIN_EMAILS = envList("SUPER_ADMIN_EMAILS");

  async function loadAdminsFromFirestore() {
    const now = Date.now();
    if (_adminCache.admins.length && (now - _adminCache.ts) < ADMIN_CACHE_TTL_MS) {
      return _adminCache.admins;
    }

    try {
      const snap = await firestore.collection("settings").doc("auth").get();
      const data = snap.exists ? (snap.data() || {}) : {};
      const admins = Array.isArray(data.admins) ? data.admins.map(normEmail).filter(Boolean) : [];

      _adminCache = { ts: now, admins };
      return admins;
    } catch (e) {
      // don’t break app if settings doc not readable
      console.error("Context admin cache load error:", e);
      _adminCache = { ts: now, admins: [] };
      return [];
    }
  }

  return async function appContextMiddleware(req, res, next) {
    // ✅ Always set appEnv for templates
    res.locals.appEnv = process.env.APP_ENV || process.env.NODE_ENV || "dev";

    const isTest =
      process.env.NODE_ENV === "test" ||
      process.env.JEST_WORKER_ID !== undefined;
    if (isTest) return next();

    try {
      const doc = await firestore.collection("meta").doc("sync_status").get();
      res.locals.syncStatus = doc.exists ? doc.data() : null;
    } catch (e) {
      console.error("Context middleware error:", e);
      res.locals.syncStatus = null;
    }

    // user
    res.locals.user = req.user || null;

    // ✅ admin flag for UI (does NOT replace route protection)
    try {
      const email = normEmail(req.user?.email);
      let isAdmin = false;

      if (email) {
        if (SUPER_ADMIN_EMAILS.includes(email)) {
          isAdmin = true;
        } else {
          const admins = await loadAdminsFromFirestore();
          isAdmin = admins.includes(email);
        }
      }

      res.locals.isAdmin = !!isAdmin;

      // optional: expose super admins for UI badges (if you ever want it)
      res.locals.superAdmins = SUPER_ADMIN_EMAILS;
    } catch (e) {
      res.locals.isAdmin = false;
    }

    return next();
  };
};
