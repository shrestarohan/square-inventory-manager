// scripts/generate-tests.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "__tests__", "generated");
const INCLUDE_DIRS = ["routes", "lib"]; // add "scripts" if you want
const INCLUDE_FILES = ["app.js", "server.js", "package.json"];
const EXCLUDE = [
  ".git",
  "node_modules",
  "coverage",
  "dist",
  "build",
  ".next",
  ".cache",
  "secrets",
  ".env",
];

function shouldExclude(p) {
  const parts = p.split(path.sep);
  return parts.some((x) => EXCLUDE.includes(x)) || p.endsWith(".env");
}

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (shouldExclude(full)) continue;
    if (ent.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function pickFiles() {
  const files = new Set();

  for (const d of INCLUDE_DIRS) {
    const full = path.join(ROOT, d);
    if (fs.existsSync(full)) {
      for (const f of walk(full)) {
        if (f.endsWith(".js") || f.endsWith(".mjs") || f.endsWith(".cjs")) files.add(f);
      }
    }
  }

  for (const f of INCLUDE_FILES) {
    const full = path.join(ROOT, f);
    if (fs.existsSync(full)) files.add(full);
  }

  return [...files].sort();
}

function rel(p) {
  return path.relative(ROOT, p).replaceAll("\\", "/");
}

function readFileSafe(p) {
  const s = fs.readFileSync(p, "utf8");
  // very light redaction (you can expand this)
  return s.replaceAll(process.env.OPENAI_API_KEY || "", "[REDACTED]");
}

function chunkString(str, maxChars = 12000) {
  const chunks = [];
  let i = 0;
  while (i < str.length) {
    chunks.push(str.slice(i, i + maxChars));
    i += maxChars;
  }
  return chunks;
}

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);
}

async function generateTestForFile(filePath, content) {
  const fileRel = rel(filePath);

  const prompt = `
You are a senior Node.js engineer writing Jest tests.

Repository context:
- This is an Express app.
- Prefer supertest for route tests.
- DO NOT make network calls.
- Mock Firestore/Square/OpenAI dependencies as needed.
- Keep tests deterministic.

Task:
Write Jest test file(s) for: ${fileRel}

Rules:
- Output ONLY a single JSON object with this shape:
  {
    "tests": [
      { "path": "__tests__/generated/<name>.test.js", "content": "<file content>" }
    ],
    "notes": "<short notes>"
  }
- The test file should run with "jest --runInBand".
- If the code depends on env vars, set process.env safely inside the test.

Here is the file content:
\`\`\`js
${content}
\`\`\`
`.trim();

  const resp = await client.responses.create({
    model: "gpt-5-mini",          // choose your preferred model
    input: prompt,
    // If your org/project supports it, you can reduce retained logs by not storing:
    // store: false,
  });

  // Responses API returns text in output; easiest is to concatenate all text parts
  const text = resp.output
    .flatMap((item) => item.content || [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Model did not return valid JSON for ${fileRel}. First 400 chars:\n` +
        text.slice(0, 400)
    );
  }

  return parsed;
}

function writeTests(tests) {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const t of tests) {
    const outPath = path.join(ROOT, t.path);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, t.content, "utf8");
    console.log("Wrote:", t.path);
  }
}

async function main() {
  const files = pickFiles();
  console.log(`Found ${files.length} files to consider.`);

  // Small heuristic: generate tests only for smaller files first
  const selected = files.filter((f) => fs.statSync(f).size < 80_000);
  console.log(`Selected ${selected.length} files (size < 80KB).`);

  for (const f of selected) {
    const raw = readFileSafe(f);
    const chunks = chunkString(raw, 12000);

    // If file is large, only send first chunk + last chunk
    const send =
      chunks.length <= 2 ? raw : chunks[0] + "\n\n/* ...snip... */\n\n" + chunks[chunks.length - 1];

    console.log(`Generating tests for ${rel(f)} (${raw.length} chars)…`);

    const result = await generateTestForFile(f, send);

    // If model didn't propose a path, create one
    const fallbackName = rel(f).replaceAll("/", "__").replaceAll(".", "_");
    const id = sha1(rel(f) + raw.length);
    const tests =
      result.tests?.length
        ? result.tests
        : [
            {
              path: `__tests__/generated/${fallbackName}.${id}.test.js`,
              content: `// No tests returned for ${rel(f)}\n`,
            },
          ];

    writeTests(tests);

    if (result.notes) console.log("Notes:", result.notes);
  }

  console.log("✅ Done. Run: npm test");
}

main().catch((err) => {
  console.error("❌ generate-tests failed:", err.message);
  process.exit(1);
});
