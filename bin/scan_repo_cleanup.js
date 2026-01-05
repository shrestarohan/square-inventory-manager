#!/usr/bin/env node
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const IGNORE = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT).map(f => path.relative(ROOT, f));

const result = {
  rootFiles: files.filter(f => !f.includes("/")),
  shellScripts: files.filter(f => f.endsWith(".sh")),
  nodeScripts: files.filter(f => f.endsWith(".js")),
  envFiles: files.filter(f => f.includes(".env")),
  dockerFiles: files.filter(f => f.toLowerCase().includes("docker")),
  possibleSecrets: files.filter(f =>
    /\.(env|json|js)$/.test(f) && !f.includes("node_modules")
  ),
};

fs.writeFileSync("repo.cleanup.json", JSON.stringify(result, null, 2));
console.log("✅ repo.cleanup.json generated");
