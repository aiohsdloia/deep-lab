#!/usr/bin/env node
// Inspect a workspace after an in-app /research run and report whether the
// product recording chain actually captured it:
//   .deeplab/runs.jsonl        local run records (app record_run)
//   .deeplab/remote-runs.jsonl skill-recorded remote runs (merged read)
//   .deeplab/provenance.jsonl  authored-file versions
//   .deeplab/logs/<hash>.txt   content-addressed run logs
// Usage: node scripts/dev/check-research-recordings.mjs <workspace-root>
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: node check-research-recordings.mjs <workspace-root>");
  process.exit(2);
}
const meta = join(root, ".deeplab");

const expectedArtifacts = [
  ["research/exploration.md", 200],
  ["research/literature-notes.md", 200],
  ["experiment/analysis.py", 300],
  ["experiment/results.json", 50],
  ["experiment/figure.svg", 200],
  ["report/report.md", 300],
];

// Files the app's write tool authored in-session. Script-generated outputs
// (results.json, figure.svg) are attributed to the run that produced them, not
// to authored-file provenance, so they are not required here.
const authoredFiles = [
  "research/exploration.md",
  "research/literature-notes.md",
  "experiment/analysis.py",
  "report/report.md",
];

function readJsonl(rel) {
  const file = join(meta, rel);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const findings = [];
function record(name, ok, detail) {
  findings.push({ name, ok, detail });
  console.log(`${ok ? "[ok]     " : "[FAIL]   "} ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log(`workspace : ${root}`);
console.log(`meta dir  : ${meta}${existsSync(meta) ? "" : " (missing — nothing was recorded)"}`);

const artifacts = [];
for (const [rel, min] of expectedArtifacts) {
  const file = join(root, rel);
  if (!existsSync(file)) {
    artifacts.push({ rel, ok: false });
    continue;
  }
  const size = readFileSync(file).length;
  artifacts.push({ rel, ok: size >= min, size });
}
record(
  "pipeline artifacts present",
  artifacts.every((a) => a.ok),
  artifacts.every((a) => a.ok)
    ? "all six deliverables exist"
    : artifacts.filter((a) => !a.ok).map((a) => a.rel).join(", ") + " missing/too small",
);

const runs = readJsonl("runs.jsonl");
const remote = readJsonl("remote-runs.jsonl");
const localRuns = runs.filter((r) => r && r.surface === "local");
const pyRuns = localRuns.filter((r) => typeof r.command === "string" && /python/.test(r.command));
const okRuns = pyRuns.filter((r) => r.status === "ok");
record(
  "runs.jsonl has a local python run",
  okRuns.length >= 1,
  `${runs.length} local record(s), ${okRuns.length} ok python run(s)${remote.length ? `, ${remote.length} remote record(s)` : ""}`,
);
if (okRuns.length > 0) {
  const latest = okRuns[okRuns.length - 1];
  console.log(`  latest run  : ${latest.runId} ${latest.command}`);
  console.log(`  code pinned : ${(latest.code ?? []).length} file(s); outputs: ${(latest.outputs ?? []).length}`);
  console.log(`  env         : ${JSON.stringify(latest.env ?? {})}`);
}

const provenance = readJsonl("provenance.jsonl");
const tracked = provenance.filter((p) => authoredFiles.some((rel) => p.path === rel || p.path?.endsWith(rel)));
record(
  "provenance.jsonl versions authored pipeline files",
  tracked.length >= authoredFiles.length,
  `${tracked.length}/${authoredFiles.length} authored files versioned (generated outputs are attributed to runs)`,
);

const logsDir = join(meta, "logs");
const logs =
  existsSync(logsDir) && existsSync(join(logsDir)) ? readdirSync(logsDir).length : 0;
record("content-addressed run logs exist", logs >= 1, `${logs} log file(s) under .deeplab/logs`);

const ok = findings.every((f) => f.ok);
console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"} (${findings.filter((f) => f.ok).length}/${findings.length})`);
console.log(
  ok
    ? "The in-app /research run was fully captured (runs + provenance + artifacts)."
    : "Recording chain incomplete. If you ran /research in the app and still see FAIL, share this output with the maintainer.",
);
process.exit(ok ? 0 : 1);
