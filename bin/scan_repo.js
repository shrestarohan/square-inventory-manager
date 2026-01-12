#!/usr/bin/env node
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function readText(p) { return fs.readFileSync(p, "utf8"); }
function safeReadText(p) { try { return readText(p); } catch { return ""; } }

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function readJSON(p) { try { return JSON.parse(readText(p)); } catch { return null; } }

function extractEnvKeysFromCode(text) {
  const keys = new Set();
  for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) keys.add(m[1]);
  for (const m of text.matchAll(/process\.env\[\s*["']([A-Z0-9_]+)["']\s*\]/g)) keys.add(m[1]);
  return keys;
}

function extractExpressRoutes(fileText) {
  // Best-effort: router.get('/path' ...) or app.get('/path' ...)
  const out = [];
  const re = /\b(router|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  for (const m of fileText.matchAll(re)) {
    out.push({ method: m[2].toUpperCase(), path: m[3] });
  }
  return out;
}

function extractGcloudCommands(fileText) {
  const lines = fileText.split(/\r?\n/);
  return lines.filter(l => l.trim().startsWith("gcloud ")).slice(0, 80);
}

function listFiles(dir) {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).sort();
}

function summarizeDockerfile(dockerText) {
  if (!dockerText) return null;
  const from = dockerText.match(/^\s*FROM\s+([^\s]+)/mi)?.[1] || null;
  const workdir = dockerText.match(/^\s*WORKDIR\s+(.+)$/mi)?.[1]?.trim() || null;
  const cmd = dockerText.match(/^\s*CMD\s+(.+)$/mi)?.[1]?.trim() || null;
  return { from, workdir, cmd };
}

function main() {
  const files = walk(ROOT);

  const pkg = readJSON(path.join(ROOT, "package.json"));
  const dockerText = exists(path.join(ROOT, "Dockerfile")) ? readText("Dockerfile") : null;

  const envKeys = new Set();
  const routes = [];
  const gcloudCmds = [];
  const notableFiles = [];

  const candidatesNotable = [
    "app.js", "server.js", "Dockerfile", "README.md", "SCRIPTS.md", "DOCS.md",
    "lib/firestore.js", "lib/loadEnv.js"
  ];
  for (const f of candidatesNotable) if (exists(path.join(ROOT, f))) notableFiles.push(f);

  for (const f of files) {
    if (!/\.(js|cjs|mjs|ts|sh)$/.test(f)) continue;
    const rel = path.relative(ROOT, f);
    const stat = fs.statSync(f);
    if (stat.size > 600_000) continue;

    const text = safeReadText(f);
    extractEnvKeysFromCode(text).forEach(k => envKeys.add(k));

    // Routes
    if (rel.startsWith("routes/") || rel === "app.js" || rel === "server.js") {
      extractExpressRoutes(text).forEach(r => routes.push({ file: rel, ...r }));
    }

    // gcloud commands
    if (rel.endsWith(".sh")) {
      const cmds = extractGcloudCommands(text);
      if (cmds.length) gcloudCmds.push({ file: rel, commands: cmds });
    }
  }

  // Folder inventory (top-level)
  const topLevel = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(d => !IGNORE_DIRS.has(d.name))
    .map(d => ({ name: d.name, type: d.isDirectory() ? "dir" : "file" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const summary = {
    name: pkg?.name || path.basename(ROOT),
    description: pkg?.description || "",
    version: pkg?.version || "",
    node: summarizeDockerfile(dockerText)?.from || "unknown",
    docker: summarizeDockerfile(dockerText),
    npmScripts: pkg?.scripts || {},
    dependencies: pkg?.dependencies || {},
    devDependencies: pkg?.devDependencies || {},
    topLevel,
    binScripts: listFiles(path.join(ROOT, "bin")),
    scripts: listFiles(path.join(ROOT, "scripts")),
    routes, // discovered endpoints
    gcloudCmds, // discovered gcloud usage from shell scripts
    notableFiles,
    envVars: [...envKeys].sort()
  };

  fs.writeFileSync("repo.summary.json", JSON.stringify(summary, null, 2), "utf8");
  console.log("✅ repo.summary.json generated (detailed)");
}

main();
