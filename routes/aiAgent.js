const express = require('express');
const router = express.Router();
const { run } = require('../scripts/aiAgent/runIdeasAgent');

// Optional: protect with a shared secret (recommended)
function requireCronAuth(req, res, next) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return next(); // if unset, allow (dev)
  const got = req.headers['x-cron-secret'];
  if (got !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
}

router.get('/health', (req, res) => res.send('ok'));

router.get('/run-ideas-agent', (req, res) =>
  res.status(405).send('Use POST /api/ai/run-ideas-agent')
);

router.post('/run-ideas-agent', requireCronAuth, async (req, res) => {
  try {
    const result = await run();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

module.exports = router;
