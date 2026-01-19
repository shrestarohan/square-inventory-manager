// routes/adminAudit.js
const express = require("express");

module.exports = function buildAdminAuditRouter({ firestore, requireLogin, requireAdmin }) {
  const router = express.Router();

  // Page
  router.get("/admin/audit", requireLogin, requireAdmin, async (req, res) => {
    res.render("admin-audit", {});
  });

  // API: list recent logs
  router.get("/api/admin/audit", requireLogin, requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit || "200", 10), 1), 500);
      const action = (req.query.action || "").toString().trim();
      const actor = (req.query.actor || "").toString().trim().toLowerCase();

      let q = firestore.collection("audit_logs").orderBy("ts", "desc").limit(limit);

      // (simple filters)
      if (action) q = q.where("action", "==", action);
      if (actor) q = q.where("actor_email", "==", actor);

      const snap = await q.get();
      const logs = snap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

      return res.json({ success: true, logs });
    } catch (e) {
      console.error("admin audit list failed:", e);
      return res.status(500).json({ success: false, error: "Failed to load audit logs" });
    }
  });

  return router;
};
