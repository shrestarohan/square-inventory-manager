// lib/loadEnv.js
const path = require("path");
const dotenv = require("dotenv");

// -----------------------------
// Detect Cloud Run
// -----------------------------
// Cloud Run sets K_SERVICE automatically.
const isCloudRun = !!process.env.K_SERVICE;

// -----------------------------
// Load dotenv locally only
// -----------------------------
const envName = process.env.ENV_FILE || "secrets/.env"; // e.g. ".env.prod"

if (!isCloudRun) {
  dotenv.config({
    path: path.resolve(process.cwd(), envName),
    override: false,
  });
  console.log("Loaded env file:", envName);
} else {
  console.log("Cloud Run detected; skipping dotenv. Using process.env only");
}

function deleteIfEmpty(name) {
  if (Object.prototype.hasOwnProperty.call(process.env, name) && String(process.env[name]).trim() === "") {
    delete process.env[name];
    console.log(`Sanitized empty env var: ${name} (deleted)`);
  }
}

// Most common offenders for Firestore auth crashes
const GOOGLE_EMPTY_SENSITIVE = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CREDENTIALS",
  "FIREBASE_CONFIG",
  "GCLOUD_PROJECT",
  "GCP_PROJECT",
];

for (const k of GOOGLE_EMPTY_SENSITIVE) deleteIfEmpty(k);

// Optional: aggressively delete ANY empty GOOGLE_/GCLOUD_/GCP_ vars
for (const [k, v] of Object.entries(process.env)) {
  if ((k.startsWith("GOOGLE_") || k.startsWith("GCLOUD_") || k.startsWith("GCP_")) && String(v).trim() === "") {
    delete process.env[k];
    console.log(`Sanitized empty env var: ${k} (deleted)`);
  }
}

// -----------------------------
// Helpers
// -----------------------------
function isPresent(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === "string" && v.trim() === "") return false;
  return true;
}

function maskValue(v) {
  if (!isPresent(v)) return "";
  const s = String(v);
  if (s.length <= 6) return "***";
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

function requireEnv(names, opts = {}) {
  const {
    label = "Required environment variables",
    exitCode = 1,
    printPresentSummary = true,
    optional = [],
    requireOneOf = [], // array of arrays: [ ["A","B"], ["X","Y","Z"] ]
  } = opts;

  const missing = [];
  for (const n of names) {
    if (optional.includes(n)) continue;
    if (!isPresent(process.env[n])) missing.push(n);
  }

  const oneOfMissingGroups = [];
  for (const group of requireOneOf) {
    const ok = group.some((n) => isPresent(process.env[n]));
    if (!ok) oneOfMissingGroups.push(group);
  }

  if (missing.length || oneOfMissingGroups.length) {
    const lines = [];
    lines.push("❌ ENV CHECK FAILED");
    lines.push(`   ${label}`);
    lines.push(`   Environment: ${isCloudRun ? "cloud-run" : "local"} (${envName})`);

    if (missing.length) {
      lines.push("   Missing:");
      for (const n of missing) lines.push(`     - ${n}`);
    }

    if (oneOfMissingGroups.length) {
      lines.push("   Missing (need at least ONE of each group):");
      for (const group of oneOfMissingGroups) {
        lines.push(`     - one of: ${group.join(", ")}`);
      }
    }

    lines.push("");
    lines.push("Fix:");
    lines.push(" - Local: add to your .env file");
    lines.push(" - Cloud Run: set env vars on the service (or in Secret Manager and mount)");
    console.error(lines.join("\n"));

    // Fail fast so Cloud Run logs show exactly why the revision isn't Ready
    process.exit(exitCode);
  }

  if (printPresentSummary) {
    // Only show a safe summary (masked) for a few key vars
    const sample = names
      .filter((n) => isPresent(process.env[n]))
      .slice(0, 8)
      .map((n) => `${n}=${maskValue(process.env[n])}`);

    console.log(`✅ ENV CHECK OK (${isCloudRun ? "cloud-run" : "local"})`);
    if (sample.length) console.log("   Present (masked):", sample.join("  "));
  }
}

// -----------------------------
// Define what you require
// -----------------------------
// Adjust this list to your project.
// Keep it strict for prod; loosen for dev if you want by using APP_ENV.
const APP_ENV = (process.env.APP_ENV || process.env.NODE_ENV || "dev").toLowerCase();

const REQUIRED = [
  "APP_ENV",
  "FIRESTORE_DATABASE_ID",     // if you use multi-db selection
  "GOOGLE_CLOUD_PROJECT",   // or GCP_PROJECT depending on your code
  "CRON_SECRET",            // if you protect cron routes
  "OPENAI_API_KEY",
  "SQUARE_ACCESS_TOKEN",
  "SQUARE_APP_ID",
  "SQUARE_APP_SECRET",
  "SQUARE_REDIRECT_URI",
  "SQUARE_ENV",
];

// Typical API keys / tokens (only require if those features are enabled)
const OPTIONAL = [];

// Example: require at least one credential style for Google auth
// (If you're relying on Cloud Run default service account, you can remove this.)
const REQUIRE_ONE_OF = [
  // ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT"], // example group
];

// If prod, be stricter
if (APP_ENV === "prod" || APP_ENV === "production") {
  // e.g. in prod you may want Square + OpenAI required
  REQUIRED.push("SQUARE_ACCESS_TOKEN");
  // REQUIRED.push("OPENAI_API_KEY");
}

// Run checks
requireEnv(REQUIRED, {
  optional: OPTIONAL,
  requireOneOf: REQUIRE_ONE_OF,
  label: "Startup config",
});

// Export flags if you want to reuse in other modules
module.exports = {
  isCloudRun,
  envName,
  APP_ENV,
  requireEnv,
};
