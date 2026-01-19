// middleware/requireAdmin.js
function normEmail(s) {
  return String(s || "").trim().toLowerCase();
}

/**
 * Admin check:
 * - Uses Firestore: settings/auth.admins (array of emails)
 * - Fallback: process.env.SUPER_ADMIN_EMAIL (optional, recommended for bootstrap)
 */
module.exports = function makeRequireAdmin({ firestore }) {
  const SUPER = normEmail(process.env.SUPER_ADMIN_EMAIL || "");

  return async function requireAdmin(req, res, next) {
    try {
      const email = normEmail(req.user?.email || "");
      if (!email) return res.status(403).send("Forbidden");

      // bootstrap fallback
      if (SUPER && email === SUPER) return next();

      const snap = await firestore.collection("settings").doc("auth").get();
      const d = snap.exists ? (snap.data() || {}) : {};
      const admins = Array.isArray(d.admins) ? d.admins.map(normEmail).filter(Boolean) : [];

      if (!admins.includes(email)) return res.status(403).send("Forbidden");
      return next();
    } catch (e) {
      return next(e);
    }
  };
};
