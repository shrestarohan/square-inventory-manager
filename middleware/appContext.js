module.exports = function appContext({ firestore }) {
  return async function (req, res, next) {
    try {
      res.locals.appEnv = process.env.APP_ENV || process.env.NODE_ENV || 'dev';
      res.locals.user = req.user || null;

      // sync status for header
      const doc = await firestore.collection('meta').doc('sync_status').get();
      res.locals.syncStatus = doc.exists ? doc.data() : null;
    } catch (e) {
      console.error('Context middleware error:', e);
      res.locals.syncStatus = null;
    }
    next();
  };
};
