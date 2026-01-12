#!/usr/bin/env node
/**
 * bin/cleanup_audit.js
 * Generates:
 *  - cleanup.report.json
 *  - CLEANUP.md
 *
 * Safe by design:
 *  - Does NOT print secret values
 *  - Only detects patterns, filenames, and env key names
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo",
]);

const MAX_FILE_SIZE = 700_000; // skip huge files

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function readText(p) { return fs.readFileSync(p, "utf8"); }
function safeReadText(p) { try { return readText(p); } catch { return ""; } }

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function walk(dir, out = []) {
  for (const ent of listDir(dir)) {
    if (IGNORE_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function rel(p) { return path.relative(ROOT, p); }

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function extractEnvKeysFromDotenv(text) {
  const keys = new Set();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^([A-Z0-9_]+)\s*=/);
    if (m) keys.add(m[1]);
  }
  return [...keys].sort();
}

function extractEnvKeysFromCode(text) {
  const keys = new Set();
  for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) keys.add(m[1]);
  for (const m of text.matchAll(/process\.env\[\s*["']([A-Z0-9_]+)["']\s*\]/g)) keys.add(m[1]);
  return keys;
}

function extractGcloudLines(text) {
  return text
    .split(/\r?\n/)
    .map((l, i) => ({ line: i + 1, text: l }))
    .filter(o => o.text.trim().startsWith("gcloud "))
    .slice(0, 120);
}

function extractPathDrift(text) {
  const hits = [];
  if (text.includes("/usr/src/app")) hits.push("/usr/src/app");
  if (text.includes("WORKDIR /usr/src/app")) hits.push("WORKDIR /usr/src/app");
  if (text.includes("WORKDIR /app")) hits.push("WORKDIR /app");
  if (text.includes("/app/")) hits.push("/app");
  return [...new Set(hits)];
}

// super conservative: look for “shape” of secrets, but don’t print values
function detectSecretPatterns(text) {
  const findings = [];
  const patterns = [
    { name: "OpenAI key prefix", re: /\bsk-[A-Za-z0-9_\-]{10,}/g },
    { name: "Slack webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/\-_]+/g },
    { name: "Square token-ish", re: /\bEAAA[A-Za-z0-9_\-]{10,}\b/g },
    { name: "GOCSP (Google client secret prefix)", re: /\bGOCSPX-[A-Za-z0-9_\-]{10,}\b/g },
    { name: "Generic *_SECRET assignment", re: /\b[A-Z0-9_]*SECRET[A-Z0-9_]*\s*=\s*["']?[^"'\n#]{8,}/g },
  ];
  for (const p of patterns) {
    if (p.re.test(text)) findings.push(p.name);
    p.re.lastIndex = 0;
  }
  return findings;
}

function parseDockerfile(dockerText) {
  if (!dockerText) return null;
  const from = dockerText.match(/^\s*FROM\s+([^\s]+)/mi)?.[1] || null;
  const workdir = dockerText.match(/^\s*WORKDIR\s+(.+)$/mi)?.[1]?.trim() || null;
  const cmd = dockerText.match(/^\s*CMD\s+(.+)$/mi)?.[1]?.trim() || null;
  return { from, workdir, cmd };
}

function computeLikelyDeadJs(files, importEdges) {
  // Best-effort: treat entrypoints as roots; find reachable via imports/requires.
  const roots = new Set([
    "app.js", "server.js",
    ...files.filter(f => f.startsWith("bin/") && f.endsWith(".js")),
    ...files.filter(f => f.startsWith("scripts/") && f.endsWith(".js")),
  ]);

  const graph = new Map();
  for (const f of files) if (f.endsWith(".js")) graph.set(f, new Set());

  for (const [from, tos] of importEdges.entries()) {
    if (!graph.has(from)) continue;
    for (const to of tos) if (graph.has(to)) graph.get(from).add(to);
  }

  const seen = new Set();
  const stack = [...roots].filter(r => graph.has(r));
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of graph.get(cur) || []) stack.push(nxt);
  }

  // Likely dead: JS files not reachable from these roots AND not in routes/lib/middleware/services (often used indirectly)
  const allowPrefix = ["routes/", "lib/", "middleware/", "services/", "views/", "public/"];
  const dead = [];
  for (const f of files) {
    if (!f.endsWith(".js")) continue;
    if (seen.has(f)) continue;
    if (allowPrefix.some(p => f.startsWith(p))) continue;
    dead.push(f);
  }
  return dead.sort();
}

function extractImportEdges(filesAbs) {
  // Best-effort local imports only
  const edges = new Map(); // relFrom -> Set(relTo)
  for (const abs of filesAbs) {
    const r = rel(abs);
    if (!r.endsWith(".js")) continue;

    const st = fs.statSync(abs);
    if (st.size > MAX_FILE_SIZE) continue;

    const txt = safeReadText(abs);
    const tos = new Set();

    // require("./x") or require("../x")
    for (const m of txt.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      tos.add(m[1]);
    }
    // import ... from "./x"
    for (const m of txt.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      tos.add(m[1]);
    }

    const resolved = new Set();
    for (const t of tos) {
      // resolve only within repo, assume .js if omitted
      const base = path.resolve(path.dirname(abs), t);
      const candidates = [
        base,
        base + ".js",
        path.join(base, "index.js"),
      ];
      for (const c of candidates) {
        if (exists(c)) { resolved.add(rel(c)); break; }
      }
    }
    edges.set(r, resolved);
  }
  return edges;
}

function main() {
  const filesAbs = walk(ROOT);
  const files = filesAbs.map(rel).sort();

  const dockerPath = path.join(ROOT, "Dockerfile");
  const dockerText = exists(dockerPath) ? readText(dockerPath) : "";
  const docker = parseDockerfile(dockerText);

  const gitignore = exists(path.join(ROOT, ".gitignore")) ? readText(".gitignore") : "";
  const dockerignore = exists(path.join(ROOT, ".dockerignore")) ? readText(".dockerignore") : "";

  // env key inventory from dotenv files (if present)
  const envFiles = [
    path.join(ROOT, ".env"),
    path.join(ROOT, ".env.deploy"),
    path.join(ROOT, "secrets", ".env"),
    path.join(ROOT, "secrets", ".env.deploy"),
    path.join(ROOT, "scripts", ".env"),
    path.join(ROOT, "scripts", ".env.deploy"),
  ].filter(exists);

  const envKeyByFile = {};
  for (const f of envFiles) {
    envKeyByFile[rel(f)] = extractEnvKeysFromDotenv(readText(f));
  }

  // env keys referenced in code
  const envKeysInCode = new Set();
  const secretsFindings = [];
  const gcloudByFile = [];
  const pathDriftByFile = [];

  for (const abs of filesAbs) {
    const r = rel(abs);
    if (!/\.(js|sh|yml|yaml|json|Dockerfile)$/.test(r) && r !== "Dockerfile") continue;

    const st = fs.statSync(abs);
    if (st.size > MAX_FILE_SIZE) continue;

    const txt = safeReadText(abs);

    // env vars
    if (r.endsWith(".js")) extractEnvKeysFromCode(txt).forEach(k => envKeysInCode.add(k));

    // gcloud usage
    if (r.endsWith(".sh")) {
      const g = extractGcloudLines(txt);
      if (g.length) gcloudByFile.push({ file: r, gcloudLines: g });
    }

    // path drift
    const drift = extractPathDrift(txt);
    if (drift.length) pathDriftByFile.push({ file: r, drift });

    // secret patterns (don’t output values)
    const sec = detectSecretPatterns(txt);
    if (sec.length) secretsFindings.push({ file: r, patterns: sec });
  }

  const importEdges = extractImportEdges(filesAbs);
  const likelyDeadJs = computeLikelyDeadJs(files, importEdges);

  const envKeysFromFiles = new Set(Object.values(envKeyByFile).flat());
  const missingInEnvFiles = [...envKeysInCode].filter(k => !envKeysFromFiles.has(k)).sort();
  const unusedInCode = [...envKeysFromFiles].filter(k => !envKeysInCode.has(k)).sort();

  const report = {
    generatedAt: new Date().toISOString(),
    docker,
    counts: {
      files: files.length,
      js: files.filter(f => f.endsWith(".js")).length,
      sh: files.filter(f => f.endsWith(".sh")).length,
    },
    checks: {
      hasGitignore: exists(path.join(ROOT, ".gitignore")),
      hasDockerignore: exists(path.join(ROOT, ".dockerignore")),
    },
    ignoreSnippets: {
      gitignoreHead: gitignore.split(/\r?\n/).slice(0, 40),
      dockerignoreHead: dockerignore.split(/\r?\n/).slice(0, 40),
    },
    envFiles: Object.keys(envKeyByFile),
    envKeyByFile,
    envKeysInCode: [...envKeysInCode].sort(),
    envMissingFromEnvFiles: missingInEnvFiles,
    envUnusedByCode: unusedInCode,
    gcloudByFile,
    pathDriftByFile,
    secretsFindings,
    likelyDeadJs,
    topLevel: files.filter(f => !f.includes("/")),
  };

  fs.writeFileSync(path.join(ROOT, "cleanup.report.json"), JSON.stringify(report, null, 2), "utf8");

  // CLEANUP.md (human)
  const md = [];
  md.push(`# Cleanup Audit`);
  md.push(`Generated: ${report.generatedAt}`);
  md.push(``);
  md.push(`## Summary`);
  md.push(`- Total files: ${report.counts.files}`);
  md.push(`- JS files: ${report.counts.js}`);
  md.push(`- Shell scripts: ${report.counts.sh}`);
  md.push(`- Docker: ${report.docker ? `FROM ${report.docker.from || "?"}, WORKDIR ${report.docker.workdir || "?"}` : "No Dockerfile detected"}`);
  md.push(``);

  md.push(`## High Priority Checks`);
  md.push(`- .gitignore present: ${report.checks.hasGitignore ? "✅" : "❌"}`);
  md.push(`- .dockerignore present: ${report.checks.hasDockerignore ? "✅" : "❌"}`);
  md.push(``);

  md.push(`## Path Drift (WORKDIR /app vs /usr/src/app)`);
  if (report.pathDriftByFile.length === 0) {
    md.push(`No obvious path drift strings found.`);
  } else {
    for (const x of report.pathDriftByFile) {
      md.push(`- ${x.file}: ${x.drift.join(", ")}`);
    }
  }
  md.push(``);

  md.push(`## Env Vars`);
  md.push(`### Env files found`);
  report.envFiles.length ? report.envFiles.forEach(f => md.push(`- ${f}`)) : md.push(`- (none detected)`);
  md.push(``);
  md.push(`### Env vars referenced in code but missing from env files`);
  if (report.envMissingFromEnvFiles.length) report.envMissingFromEnvFiles.forEach(k => md.push(`- ${k}`));
  else md.push(`- (none)`);
  md.push(``);
  md.push(`### Env vars present in env files but not referenced in code`);
  if (report.envUnusedByCode.length) report.envUnusedByCode.forEach(k => md.push(`- ${k}`));
  else md.push(`- (none)`);
  md.push(``);

  md.push(`## gcloud usage in shell scripts`);
  if (!report.gcloudByFile.length) md.push(`- (none detected)`);
  else {
    for (const f of report.gcloudByFile) {
      md.push(`### ${f.file}`);
      for (const l of f.gcloudLines.slice(0, 20)) md.push(`- L${l.line}: \`${l.text.trim()}\``);
      if (f.gcloudLines.length > 20) md.push(`- ... (${f.gcloudLines.length - 20} more)`);
    }
  }
  md.push(``);

  md.push(`## Potential Secrets Detected (patterns only, no values shown)`);
  if (!report.secretsFindings.length) md.push(`- (none detected by conservative patterns)`);
  else {
    for (const s of report.secretsFindings) {
      md.push(`- ${s.file}: ${s.patterns.join(", ")}`);
    }
  }
  md.push(``);

  md.push(`## Likely Dead JS Files (best-effort)`);
  if (!report.likelyDeadJs.length) md.push(`- (none detected by heuristic)`);
  else report.likelyDeadJs.slice(0, 150).forEach(f => md.push(`- ${f}`));
  if (report.likelyDeadJs.length > 150) md.push(`- ... (${report.likelyDeadJs.length - 150} more)`);
  md.push(``);

  md.push(`## Top-level files`);
  report.topLevel.forEach(f => md.push(`- ${f}`));
  md.push(``);

  md.push(`## Next Steps`);
  md.push(`1. Review Path Drift list and standardize on one WORKDIR/path scheme (your Dockerfile currently decides).`);
  md.push(`2. Review Likely Dead JS list and confirm before deletion.`);
  md.push(`3. Ensure secrets are in Secret Manager and env files are gitignored.`);
  md.push(`4. Consolidate duplicate shell scripts (gcloud commands).`);
  md.push(``);

  fs.writeFileSync(path.join(ROOT, "CLEANUP.md"), md.join("\n"), "utf8");

  console.log("✅ Wrote cleanup.report.json and CLEANUP.md");
}

main();
