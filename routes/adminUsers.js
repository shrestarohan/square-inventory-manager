// routes/adminUsers.js
const express = require("express");
const bcrypt = require("bcryptjs");

// Reuse the same admin check as in auth.js (copy/paste or import if you moved it)
function normEmail(s) {
  return String(s || "").trim().toLowerCase();
}

module.exports = function buildAdminUsersRouter({ firestore, requireLogin, requireAdmin }) {
  const router = express.Router();

  // Admin page
  router.get("/admin/users", requireLogin, requireAdmin, async (req, res) => {
    res.render("admin-users", { actor: req.user?.email || "" });
  });

  // List users
  router.get("/api/admin/users", requireLogin, requireAdmin, async (req, res) => {
    const snap = await firestore.collection("users").limit(500).get();
    const rows = snap.docs.map(d => {
      const u = d.data() || {};
      return {
        id: d.id,
        email: u.email || d.id,
        username: u.username || "",
        role: u.role || "user",
        enabled: u.enabled !== false,
        hasPassword: !!u.passwordHash,
        updated_at: u.updated_at || null,
      };
    });

    // Sort by email
    rows.sort((a, b) => (a.email || "").localeCompare(b.email || ""));
    res.json({ success: true, users: rows });
  });

  // Create user (docId defaults to email)
  router.post("/api/admin/users", requireLogin, requireAdmin, express.json({ limit: "256kb" }), async (req, res) => {
    const email = normEmail(req.body?.email);
    const username = (req.body?.username || "").toString().trim();
    const role = (req.body?.role || "user").toString().trim();
    const enabled = req.body?.enabled === false ? false : true;
    const password = (req.body?.password || "").toString();

    if (!email || !email.includes("@")) {
      return res.status(400).json({ success: false, error: "Valid email is required." });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ success: false, error: "Password must be at least 8 characters." });
    }
    if (!["user", "admin"].includes(role)) {
      return res.status(400).json({ success: false, error: "Role must be user or admin." });
    }

    const ref = firestore.collection("users").doc(email);
    const existing = await ref.get();
    if (existing.exists) {
      return res.status(409).json({ success: false, error: "User already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await ref.set({
      email,
      username: username || null,
      role,
      enabled,
      passwordHash,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      updated_by: normEmail(req.user?.email || ""),
    });

    res.json({ success: true });
  });

  // Update user fields + optional password reset
  router.put("/api/admin/users/:id", requireLogin, requireAdmin, express.json({ limit: "256kb" }), async (req, res) => {
    const id = normEmail(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: "Missing user id." });

    const ref = firestore.collection("users").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: "User not found." });

    const patch = {};
    if (req.body.email) patch.email = normEmail(req.body.email); // usually same as id
    if (req.body.username !== undefined) patch.username = (req.body.username || "").toString().trim() || null;

    if (req.body.role !== undefined) {
      const role = (req.body.role || "user").toString().trim();
      if (!["user", "admin"].includes(role)) return res.status(400).json({ success: false, error: "Bad role." });
      patch.role = role;
    }

    if (req.body.enabled !== undefined) patch.enabled = !!req.body.enabled;

    if (req.body.password) {
      const password = String(req.body.password);
      if (password.length < 8) return res.status(400).json({ success: false, error: "Password must be >= 8 chars." });
      patch.passwordHash = await bcrypt.hash(password, 12);
    }

    patch.updated_at = new Date().toISOString();
    patch.updated_by = normEmail(req.user?.email || "");

    await ref.set(patch, { merge: true });
    res.json({ success: true });
  });

  // Disable user (safer than delete)
  router.delete("/api/admin/users/:id", requireLogin, requireAdmin, async (req, res) => {
    const id = normEmail(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: "Missing user id." });

    // Prevent disabling yourself
    const actor = normEmail(req.user?.email || "");
    if (actor && actor === id) {
      return res.status(400).json({ success: false, error: "You cannot disable yourself." });
    }

    const ref = firestore.collection("users").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: "User not found." });

    await ref.set(
      {
        enabled: false,
        updated_at: new Date().toISOString(),
        updated_by: actor,
      },
      { merge: true }
    );

    res.json({ success: true });
  });

  return router;
};
