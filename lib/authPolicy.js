// lib/authPolicy.js
const CACHE_TTL_MS = 30_000;
let cache = { ts: 0, data: null };

async function loadAuthPolicy(firestore) {
  const now = Date.now();
  if (cache.data && (now - cache.ts) < CACHE_TTL_MS) return cache.data;

  const snap = await firestore.collection("settings").doc("auth").get();
  const d = snap.exists ? (snap.data() || {}) : {};

  const policy = {
    mode: (d.mode || "allowlist").toString(),
    allowlist_emails: Array.isArray(d.allowlist_emails) ? d.allowlist_emails.map(x => String(x).toLowerCase().trim()) : [],
    allowlist_domains: Array.isArray(d.allowlist_domains) ? d.allowlist_domains.map(x => String(x).toLowerCase().trim()) : [],
    admins: Array.isArray(d.admins) ? d.admins.map(x => String(x).toLowerCase().trim()) : [],
  };

  cache = { ts: now, data: policy };
  return policy;
}

function emailDomain(email) {
  const s = String(email || "").toLowerCase().trim();
  const i = s.indexOf("@");
  return i > -1 ? s.slice(i + 1) : "";
}

function isAllowedEmail(policy, email) {
  const e = String(email || "").toLowerCase().trim();
  const domain = emailDomain(e);

  const inEmails = policy.allowlist_emails.includes(e);
  const inDomains = policy.allowlist_domains.includes(domain);

  if (policy.mode === "domain") return inDomains;
  if (policy.mode === "both") return inEmails || inDomains;
  return inEmails; // allowlist
}

function isAdmin(policy, email) {
  const e = String(email || "").toLowerCase().trim();
  return policy.admins.includes(e);
}

module.exports = { loadAuthPolicy, isAllowedEmail, isAdmin };
