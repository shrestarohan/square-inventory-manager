// routes/adminStoreAccess.js
const express = require("express");

function normEmail(s){ return String(s||"").trim().toLowerCase(); }

module.exports = function buildAdminStoreAccessRouter({ firestore, requireLogin, requireAdmin }) {
  const router = express.Router();

  router.get("/admin/store-access", requireLogin, requireAdmin, async (req, res) => {
    res.render("admin-store-access", {});
  });

  // List users + locations
  router.get("/api/admin/store-access", requireLogin, requireAdmin, async (req, res) => {
    try {
      const usersSnap = await firestore.collection("users").limit(500).get();
      const users = usersSnap.docs.map(d => {
        const r = d.data() || {};
        return {
          id: d.id,
          email: r.email || d.id,
          role: r.role || "user",
          enabled: r.enabled !== false,
          allowedLocKeys: Array.isArray(r.allowedLocKeys) ? r.allowedLocKeys : [],
          username: r.username || "",
        };
      }).sort((a,b)=> (a.email||"").localeCompare(b.email||""));

      const locSnap = await firestore.collection("location_index").get();
      const locations = locSnap.docs.map(d => {
        const r = d.data() || {};
        const locKey = (r.locKey || d.id || "").toString();
        const label =
          (r.location_name || "").toString().trim() ||
          (r.merchant_name || "").toString().trim() ||
          locKey;
        return { locKey, label };
      }).filter(x => x.locKey).sort((a,b)=> a.label.localeCompare(b.label));

      res.json({ success: true, users, locations });
    } catch (e) {
      console.error("store-access list failed:", e);
      res.status(500).json({ success:false, error:"Failed to load store access" });
    }
  });

  // Update a user's role + allowedLocKeys
  router.put("/api/admin/store-access/:id", requireLogin, requireAdmin, express.json({ limit:"128kb" }), async (req, res) => {
    try {
      const id = normEmail(req.params.id);
      if (!id) return res.status(400).json({ success:false, error:"Missing user id" });

      const role = (req.body.role || "user").toString();
      const enabled = req.body.enabled !== false;

      let allowedLocKeys = req.body.allowedLocKeys;
      if (!Array.isArray(allowedLocKeys)) allowedLocKeys = [];
      allowedLocKeys = allowedLocKeys.map(x => String(x||"").trim()).filter(Boolean);

      // Only enforce locKeys for managers; admins get all access
      const patch = { role, enabled };
      if (role === "manager") patch.allowedLocKeys = allowedLocKeys;
      if (role !== "manager") patch.allowedLocKeys = []; // keep clean

      await firestore.collection("users").doc(id).set(patch, { merge:true });

      res.json({ success:true });
    } catch (e) {
      console.error("store-access update failed:", e);
      res.status(500).json({ success:false, error:"Update failed" });
    }
  });

  return router;
};
