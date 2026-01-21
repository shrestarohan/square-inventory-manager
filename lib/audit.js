// lib/audit.js
function safeStr(x) {
  try { return (x == null) ? "" : String(x); } catch { return ""; }
}

function normEmail(s) {
  return safeStr(s).trim().toLowerCase();
}

async function writeAuditLog(firestore, {
  req,
  action,
  targetType = "",
  targetId = "",
  meta = {},
}) {
  try {
    const actor = normEmail(req?.user?.email || "");
    const ip =
      (req?.headers?.["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
      req?.ip ||
      "";
    const ua = safeStr(req?.headers?.["user-agent"] || "");

    const doc = {
      ts: new Date().toISOString(),
      actor_email: actor || "(anonymous)",
      action: safeStr(action),
      target_type: safeStr(targetType),
      target_id: safeStr(targetId),
      meta: (meta && typeof meta === "object") ? meta : { value: meta },
      ip,
      ua,
    };

    await firestore.collection("audit_logs").add(doc);
  } catch (e) {
    // Never block app flows on audit failures
    console.error("AUDIT_LOG_WRITE_FAILED:", e?.message || e);
  }
}

module.exports = { writeAuditLog };
