#!/usr/bin/env node
// Build a "clean" jsonl from a raw DSL game log plus a hand-cleaned plain-text export of it.
//
//   node scripts/build-clean-jsonl.mjs <raw.jsonl> <clean.txt> [out.jsonl] [--legacy-export]
//   pnpm clean-jsonl <raw.jsonl> <clean.txt> [out.jsonl] [--legacy-export]
//
// out.jsonl defaults to <clean.txt> with a .jsonl extension; an existing out file is overwritten.
//
// The clean txt says WHICH lines to keep; the raw jsonl supplies their ANSI colours and
// timestamps. Output uses the raw log's own record shapes (game:remote-server:raw,
// game:client:input), so LogPlayback reads it unchanged. GMCP and every dropped record are
// omitted; BEL (\x07) is stripped. Each run of consecutive kept lines is ONE multi-line raw record.
//
// Blank lines. The clean txt's blank lines are written as literal "\r\n" in the record data, so the
// terminal view (which writes the data as is) and the text / BBCode / HTML exports (recordLines() in
// LogPlayback.tsx) both reproduce the clean txt. That needs a viewer build that has recordLines().
// Older builds split a record on \r?\n and add one blank line after every record that ends in a
// newline, so on those the same file exports with doubled blanks. For such a build pass
// --legacy-export: the blank between runs is then left to that record-end blank (N-1 extra "\r\n",
// or N leading "\r\n" after an input line). The exports match the clean txt, but the terminal view
// shows no blank lines between runs.
//
// The script replays the viewer's export (and, without --legacy-export, the terminal view) over its
// own output and exits 1 unless the result equals the clean txt line for line (trailing blank lines
// ignored).
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const legacyExport = argv.includes("--legacy-export");
const [rawPath, cleanPath, outArg] = argv.filter((a) => !a.startsWith("--"));
if (!rawPath || !cleanPath) {
  console.error("usage: node scripts/build-clean-jsonl.mjs <raw.jsonl> <clean.txt> [out.jsonl] [--legacy-export]");
  process.exit(2);
}
// how the viewer splits a record into export lines (see recordLines() in LogPlayback.tsx)
const exportLines = legacyExport
  ? (d) => d.split(/\r?\n/)
  : (d) => { const l = d.split(/\r?\n/); if (l.length > 1 && l[l.length - 1] === "") l.pop(); return l; };
const outPath = outArg ?? cleanPath.replace(/\.[^./\\]*$/, "") + ".jsonl";
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
if (same(outPath, rawPath) || same(outPath, cleanPath)) {
  console.error(`Refusing to overwrite an input file: ${outPath}`);
  process.exit(2);
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g; // same pattern as src/damageParser.ts
const plainKey = (s) => s.replace(ANSI_RE, "").replace(/\x07/g, "").trimEnd();
const warnings = [];

// ── load raw records ────────────────────────────────────────────────────────
const records = fs
  .readFileSync(rawPath, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((line) => ({ line, obj: JSON.parse(line) }));

let outOfOrder = 0;
for (let i = 1; i < records.length; i++) {
  if (Date.parse(records[i].obj.timestamp) < Date.parse(records[i - 1].obj.timestamp)) outOfOrder++;
}
if (outOfOrder) warnings.push(`${outOfOrder} raw record(s) are out of timestamp order; the viewer sorts by timestamp, this script keeps file order`);

// ── line units: a record split on \r?\n, as the viewer splits it ────────────
const units = []; // { rec, kind: "raw" | "input", text, term, key, blank, stateBefore }
records.forEach((r, ri) => {
  const o = r.obj;
  if (o.type === "game:remote-server:raw") {
    const parts = (o.payload?.data ?? "").split(/(\r?\n)/);
    for (let p = 0; p < parts.length; p += 2) {
      const text = parts[p], term = parts[p + 1] ?? "";
      if (text === "" && term === "") continue; // artefact after a trailing newline
      units.push({ rec: ri, kind: "raw", text, term });
    }
  } else if (o.type === "game:client:input") {
    let inp;
    try { inp = typeof o.payload === "string" ? JSON.parse(o.payload) : o.payload; } catch { return; }
    if (inp?.type === "data" && inp?.data) units.push({ rec: ri, kind: "input", text: inp.data, term: "" });
  }
});
for (const u of units) {
  u.key = u.kind === "input" ? "> " + u.text : plainKey(u.text);
  u.blank = u.key === "";
}

// colour in force at the start of each raw unit, so a kept line stays self-contained
{
  let active = [];
  for (const u of units) {
    if (u.kind !== "raw") continue;
    u.stateBefore = active.map((p) => `\x1b[${p}m`).join("");
    for (const m of u.text.matchAll(/\x1b\[([0-9;]*)m/g)) {
      const params = m[1];
      if (params === "" || params.split(";")[0] === "0") {
        active = [];
        const rest = params.split(";").slice(1).join(";");
        if (rest) active.push(rest);
      } else active.push(params);
    }
  }
}

// ── align the clean txt's non-blank lines to the units (LCS) ────────────────
const cleanLines = fs.readFileSync(cleanPath, "utf8").split(/\r?\n/).map((l) => l.trimEnd());
const cleanIdx = cleanLines.map((l, i) => (l ? i : -1)).filter((i) => i >= 0);
const cand = units.map((u, i) => (u.blank ? -1 : i)).filter((i) => i >= 0);
const n = cand.length, m = cleanIdx.length;
const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
for (let i = n - 1; i >= 0; i--)
  for (let j = m - 1; j >= 0; j--)
    dp[i][j] = units[cand[i]].key === cleanLines[cleanIdx[j]] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
const matchOf = new Map(); // clean line index -> unit
const unmatched = [];
for (let i = 0, j = 0; j < m; ) {
  if (i >= n) { unmatched.push(cleanIdx[j++]); continue; }
  if (units[cand[i]].key === cleanLines[cleanIdx[j]]) { matchOf.set(cleanIdx[j], units[cand[i]]); i++; j++; }
  else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
  else unmatched.push(cleanIdx[j++]);
}
if (unmatched.length) {
  for (const i of unmatched) console.error(`unmatched clean line ${i + 1}: ${JSON.stringify(cleanLines[i].slice(0, 100))}`);
  console.error("Aborting: every non-blank clean line must map to a raw line (hand-edited text cannot be coloured).");
  process.exit(1);
}

// ── group the clean lines into elements (a run of raw lines, or one input line) ──
let last = cleanLines.length - 1;
while (last >= 0 && cleanLines[last] === "") last--;
const trailingBlanks = cleanLines.length - 1 - last; // includes the "" after the final newline
const elems = []; // { kind, units, gapAfter }
let first = 0, lead = 0;
while (first <= last && cleanLines[first] === "") { first++; lead++; }
if (lead) warnings.push(`clean txt starts with ${lead} blank line(s); a leading blank cannot be represented and was dropped`);
let blanks = 0;
for (let i = first; i <= last; i++) {
  if (cleanLines[i] === "") { blanks++; continue; }
  const u = matchOf.get(i);
  const prev = elems[elems.length - 1];
  if (prev && blanks === 0 && prev.kind === "raw" && u.kind === "raw") prev.units.push(u);
  else {
    if (prev) prev.gapAfter = blanks;
    if (legacyExport && prev && blanks === 0) warnings.push(`clean line ${i + 1}: raw and input lines are adjacent with no blank; the viewer will add a blank between them`);
    elems.push({ kind: u.kind, units: [u], gapAfter: 0 });
  }
  blanks = 0;
}
if (elems.length) elems[elems.length - 1].gapAfter = Math.max(0, trailingBlanks - 1);

// ── emit ────────────────────────────────────────────────────────────────────
let carried = 0, belStripped = 0, nonSgr = 0, maxSpreadMs = 0, mergedBlocks = 0;
const outRecords = [];
elems.forEach((e, k) => {
  if (e.kind === "input") {
    const inputRec = records[e.units[0].rec].obj;
    outRecords.push(inputRec);
    // an input line never carries blank lines itself: they follow it as a record of their own
    if (!legacyExport && e.gapAfter > 0) {
      outRecords.push({ ...inputRec, type: "game:remote-server:raw", subtype: "raw", payload: { type: "raw", data: "\r\n".repeat(e.gapAfter) } });
    }
    return;
  }
  const prev = elems[k - 1];
  const leading = legacyExport && prev && prev.kind === "input" ? prev.gapAfter : 0; // an input line has no record-end blank
  const lines = e.units.map((u) => {
    let t = u.text;
    if (t.includes("\x07")) { t = t.replace(/\x07/g, ""); belStripped++; }
    // carry an open colour only when visible text precedes the line's own first colour code
    const head = t.slice(0, t.indexOf("\x1b[") === -1 ? t.length : t.indexOf("\x1b["));
    if (u.stateBefore && /\S/.test(head)) { t = u.stateBefore + t; carried++; }
    if ([...t.matchAll(ANSI_RE)].some((x) => !x[0].endsWith("m"))) nonSgr++;
    return t + "\r\n";
  });
  const trailing = legacyExport ? Math.max(0, e.gapAfter - 1) : e.gapAfter; // legacy: the viewer's record-end blank covers the first
  const data = "\r\n".repeat(leading) + lines.join("") + "\r\n".repeat(trailing);
  const recs = [...new Set(e.units.map((u) => u.rec))];
  if (recs.length > 1) mergedBlocks++;
  const ts = recs.map((ri) => Date.parse(records[ri].obj.timestamp));
  maxSpreadMs = Math.max(maxSpreadMs, Math.max(...ts) - Math.min(...ts));
  const src = records[recs[0]].obj;
  outRecords.push({ ...src, payload: { ...src.payload, data } });
});
fs.writeFileSync(outPath, outRecords.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");

// ── verify: replay the viewer over the output and compare with the clean txt ──
const cleanCmp = cleanLines.slice(0, last + 1);
function diffAgainstClean(lines, label) {
  const a = lines.map((l) => l.replace(ANSI_RE, "").trimEnd());
  while (a.length && a[a.length - 1] === "") a.pop();
  const b = cleanCmp, N = a.length, M = b.length, out = [];
  const d = Array.from({ length: N + 1 }, () => new Uint16Array(M + 1));
  for (let i = N - 1; i >= 0; i--)
    for (let j = M - 1; j >= 0; j--) d[i][j] = a[i] === b[j] ? d[i + 1][j + 1] + 1 : Math.max(d[i + 1][j], d[i][j + 1]);
  let i = 0, j = 0;
  while (i < N || j < M) {
    if (i < N && j < M && a[i] === b[j]) { i++; j++; }
    else if (j >= M || (i < N && d[i + 1][j] >= d[i][j + 1])) { out.push(`  ${label}-only  #${i + 1}: ${JSON.stringify(a[i].slice(0, 80))}`); i++; }
    else { out.push(`  clean-only  #${j + 1}: ${JSON.stringify(b[j].slice(0, 80))}`); j++; }
  }
  return out;
}
// text / BBCode / HTML export (collectAnsiLines, raw + input only)
const exported = [];
// terminal view (renderAllEntries writes each record's data as is)
let terminal = "";
for (const o of outRecords) {
  if (o.type === "game:remote-server:raw") {
    for (const l of exportLines(o.payload.data ?? "")) exported.push(l);
    terminal += o.payload.data ?? "";
  } else if (o.type === "game:client:input") {
    const typed = JSON.parse(o.payload).data;
    exported.push(`\x1b[2m> ${typed}\x1b[0m`);
    terminal += `\x1b[2m> ${typed}\x1b[0m\r\n`;
  }
}
const diffs = diffAgainstClean(exported, "export");
const terminalDiffs = legacyExport ? null : diffAgainstClean(terminal.split(/\r?\n/), "terminal");

// colour check: the same number of coloured lines goes in as comes out
const hasSgr = (s) => /\x1b\[[0-9;]*m/.test(s);
const srcColoured = [...matchOf.values()].filter((u) => u.kind === "raw" && hasSgr(u.text)).length;
const outColoured = outRecords.flatMap((o) => (o.type === "game:remote-server:raw" ? o.payload.data.split(/\r?\n/) : [])).filter(hasSgr).length;

const keptRaw = [...matchOf.values()].filter((u) => u.kind === "raw").length;
const keptIn = [...matchOf.values()].filter((u) => u.kind === "input").length;
console.log(`raw records ${records.length}; line units ${units.length}`);
console.log(`clean non-blank lines ${m}; all matched; kept ${keptRaw} text + ${keptIn} input line(s)`);
console.log(`wrote ${outPath}: ${outRecords.length} records (${mergedBlocks} merged from several raw records; widest timestamp spread inside one record ${maxSpreadMs} ms)`);
console.log(`coloured lines: source ${srcColoured}, output ${outColoured}; BEL stripped from ${belStripped}; colour carried onto ${carried}; non-colour escapes ${nonSgr}`);
console.log(`viewer text export vs clean txt: ${diffs.length === 0 ? "IDENTICAL" : diffs.length + " differing line(s)"}${legacyExport ? " (--legacy-export)" : ""}`);
for (const s of diffs.slice(0, 30)) console.log(s);
if (terminalDiffs) {
  console.log(`viewer terminal view vs clean txt: ${terminalDiffs.length === 0 ? "IDENTICAL" : terminalDiffs.length + " differing line(s)"}`);
  for (const s of terminalDiffs.slice(0, 30)) console.log(s);
}
for (const w of warnings) console.log("WARNING:", w);
if (diffs.length || (terminalDiffs && terminalDiffs.length) || srcColoured !== outColoured) process.exitCode = 1;
