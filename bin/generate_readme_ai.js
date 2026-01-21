#!/usr/bin/env node
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import OpenAI from "openai";

const ROOT = process.cwd();

// Load env file (defaults to scripts/.env; override with ENV_PATH)
const ENV_PATH = process.env.ENV_PATH || path.join(ROOT, "secrets", ".env");
dotenv.config({ path: ENV_PATH });

if (!process.env.OPENAI_API_KEY) {
  console.error(`❌ OPENAI_API_KEY not found. Loaded env path: ${ENV_PATH}`);
  process.exit(1);
}

const MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

// Load repo summary facts
const summaryPath = path.join(ROOT, "repo.summary.json");
if (!fs.existsSync(summaryPath)) {
  console.error("❌ repo.summary.json not found. Run: node bin/scan_repo.js");
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

// Build a detailed prompt
const prompt = `
You are writing a detailed, developer-friendly README.md for a production Node.js repository.

Hard rules:
- Use ONLY the provided JSON facts; do not invent features, endpoints, scripts, or env vars.
- If something is unclear from JSON, say so briefly and provide a reasonable placeholder.
- Write a detailed README: aim for 1200–2500 words.
- Include practical examples (commands, flags) based on JSON content.

Structure required (use these headings in this order):
1. Project Overview
2. Key Features
3. Tech Stack
4. Repository Layout (explain each major folder found)
5. Getting Started (local dev)
6. Configuration (Environment Variables) — list keys and what they likely do based on names (do not guess values)
7. Common Workflows (build, deploy, run jobs, scripts)
8. API / Routes (group by file; list method + path)
9. Cloud Run Jobs Notes (how to run, how secrets are mounted, common failure modes)
10. Troubleshooting (at least 8 concrete issues and fixes, grounded in the repo setup)
11. Security Notes (secrets handling, .env quoting semicolons)
12. Contributing / Maintenance (how to regenerate README, lint/test if present)

JSON:
${JSON.stringify(summary, null, 2)}

Now produce README.md markdown only (no extra commentary).
`;

// Call OpenAI
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

(async () => {
  try {
    const res = await client.responses.create({
      model: MODEL,
      input: prompt
    });

    const md = (res.output_text || "").trim();
    if (!md) {
      console.error("❌ Model returned empty output.");
      process.exit(1);
    }

    fs.writeFileSync(path.join(ROOT, "README.md"), md, "utf8");
    console.log(`✅ README.md generated with model=${MODEL}`);
  } catch (err) {
    console.error("❌ OpenAI request failed:");
    console.error(err?.message || err);
    process.exit(1);
  }
})();
