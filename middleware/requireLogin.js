// middleware/requireLogin.js
module.exports = function requireLogin(req, res, next) {
  try {
    if (req.isAuthenticated && req.isAuthenticated()) return next();

    const nextUrl = encodeURIComponent(req.originalUrl || '/dashboard');
    return res.redirect(`/login?next=${nextUrl}`);
  } catch (e) {
    // fail closed
    const nextUrl = encodeURIComponent(req.originalUrl || '/dashboard');
    return res.redirect(`/login?next=${nextUrl}`);
  }
};
