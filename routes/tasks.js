const express = require('express');

module.exports = function buildTasksRouter({
  firestore,
  syncAllMerchants,
  runBuildGtinMatrix,
}) {
  const router = express.Router();

  router.post('/tasks/sync-inventory', async (req, res) => {
    try {
      await syncAllMerchants();
      res.status(200).send('Inventory sync completed');
    } catch (err) {
      console.error('Error in /tasks/sync-inventory', err);
      res.status(500).send('Inventory sync failed: ' + err.message);
    }
  });

  router.get('/tasks/full-nightly-sync', async (req, res) => {
    const runId = `full-${Date.now()}`;

    try {
      console.log('Nightly job: starting syncAllMerchants...');
      await syncAllMerchants();

      console.log('Nightly job: syncAllMerchants done. Starting runBuildGtinMatrix...');
      await runBuildGtinMatrix();

      await firestore.collection('meta').doc('sync_status').set({
        last_full_sync_at: new Date().toISOString(),
        last_full_sync_run_id: runId,
      }, { merge: true });

      res.status(200).send('✅ Nightly sync + GTIN matrix rebuild completed');
    } catch (err) {
      console.error('Error in /tasks/full-nightly-sync', err);
      res.status(500).send('Nightly job failed: ' + (err.message || String(err)));
    }
  });

  return router;
};
