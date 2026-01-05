// routes/categorySync.js
// ------------------------------------------------------------
// POST /api/categories/sync-from-square
// body: { merchantId?: "ML...." }  // optional
//
// Runs: node scripts/syncSquareCategoriesToFirestore.js [--merchant <id>]
//
// Requires:
// - scripts/syncSquareCategoriesToFirestore.js exists
// - lib/loadEnv already loaded by app.js (ok either way)
// ------------------------------------------------------------

const express = require("express");
const router = express.Router();
const { spawn } = require("child_process");
const path = require("path");

module.exports = function buildCategorySyncRouter({ requireLogin }) {
  router.post("/api/categories/sync-from-square", requireLogin, async (req, res) => {
    try {
      const merchantId = (req.body?.merchantId || "").toString().trim();

      const scriptPath = path.join(__dirname, "..", "scripts", "syncSquareCategoriesToFirestore.js");

      const args = [scriptPath];
      if (merchantId) args.push("--merchant", merchantId);
      args.push("--clean");
      
      // IMPORTANT: do NOT block request forever; stream minimal output + return when done
      const child = spawn(process.execPath, args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let out = "";
      let errOut = "";

      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (errOut += d.toString()));

      child.on("close", (code) => {
        if (code === 0) {
          return res.json({ success: true, merchantId: merchantId || null, output: out.slice(-8000) });
        }
        return res.status(500).json({
          success: false,
          merchantId: merchantId || null,
          error: `Sync failed with exit code ${code}`,
          stderr: errOut.slice(-8000),
          stdout: out.slice(-8000),
        });
      });
    } catch (e) {
      console.error("Sync-from-square error:", e);
      return res.status(500).json({ success: false, error: e.message || "Internal error" });
    }
  });

  return router;
};
