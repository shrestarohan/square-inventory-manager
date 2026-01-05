// middleware/appContext.js
module.exports = function buildAppContext({ firestore }) {
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

    // Optional (useful)
    res.locals.user = req.user || null;

    return next();
  };
};
