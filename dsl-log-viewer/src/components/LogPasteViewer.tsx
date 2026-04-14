// src/components/LogPasteViewer.tsx
import { useState, useEffect, useRef, type CSSProperties, type ChangeEvent, type FC } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  parseDmgLine, dmgSource, dmgTarget, dmgColor, stripAnsi,
  dmgAnnotation, buildRoundSummaryLines, buildFightSummaryLines,
  type DmgEvent,
} from "../damageParser";

// ─── Types ───────────────────────────────────────────────────────────────────

type Format = "rawlog" | "mudlet" | "plain";

interface Entry {
  ts?: number;   // ms offset from first entry; undefined when no timestamps
  text: string;  // game text (may contain restored ANSI or none)
}

interface Parsed {
  format: Format;
  entries: Entry[];
  hasTimestamps: boolean;
}

// ─── Format detection ────────────────────────────────────────────────────────

function detectFormat(text: string): Format {
  const sample = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 40);
  const rawlogHits = sample.filter(l => /^¤TS=/.test(l)).length;
  if (rawlogHits >= Math.max(1, sample.length * 0.4)) return "rawlog";
  const mudletHits = sample.filter(l => /^\d{2}:\d{2}:\d{2}\.\d{3} /.test(l)).length;
  if (mudletHits >= Math.max(1, sample.length * 0.3)) return "mudlet";
  return "plain";
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

// rawlog: ¤TS=ISO¤SID=UUID¤M=content¤
// ANSI codes in content are missing the leading \x1b — restore them.
function parseRawlog(text: string): Entry[] {
  const entries: Entry[] = [];
  let baseMs: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^¤TS=([^¤]+)¤SID=[^¤]+¤M=(.*)¤$/);
    if (!m) continue;
    const ms = new Date(m[1]).getTime();
    if (!isFinite(ms)) continue;
    if (baseMs === null) baseMs = ms;
    const content = m[2].replace(/\[([0-9;]*)m/g, "\x1b[$1m");
    entries.push({ ts: ms - baseMs!, text: content });
  }
  return entries;
}

// Mudlet: optional header, then "HH:MM:SS.mmm content" lines
function parseMudlet(text: string): Entry[] {
  const entries: Entry[] = [];
  let baseMs: number | null = null;
  let lastTs = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^Log session starting at/.test(line)) continue;
    const m = line.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3}) (.*)/);
    if (!m) {
      if (entries.length > 0) entries.push({ ts: lastTs, text: "" });
      continue;
    }
    const totalMs =
      parseInt(m[1]) * 3_600_000 +
      parseInt(m[2]) * 60_000 +
      parseInt(m[3]) * 1_000 +
      parseInt(m[4]);
    if (baseMs === null) baseMs = totalMs;
    let offset = totalMs - baseMs;
    if (offset < 0) offset += 86_400_000; // midnight rollover
    lastTs = offset;
    entries.push({ ts: offset, text: m[5] });
  }
  return entries;
}

// Plain text: no timestamps, each line is one entry
function parsePlain(text: string): Entry[] {
  return text.split(/\r?\n/).map(line => ({ text: line }));
}

function parseLog(text: string): Parsed {
  const format = detectFormat(text);
  const entries =
    format === "rawlog" ? parseRawlog(text) :
    format === "mudlet" ? parseMudlet(text) :
    parsePlain(text);
  return { format, entries, hasTimestamps: entries.some(e => e.ts !== undefined) };
}

// ─── Pattern-based colorization (plain / mudlet — no embedded ANSI) ──────────

const COL_RULES: [RegExp, string][] = [
  [/\bis DEAD!+/, "\x1b[1;31m"],
  [/^(You (tear|rip|reach through|pull out|slice)|.+\b(plops|severed|ripped from|sliced from))\b/i, "\x1b[1;31m"],
  [/\b(devastate[sd]?|decimate[sd]?|obliterate[sd]?|annihilate[sd]?|massacre[sd]?|murder[sed]?|slaughter[sed]?|disembowel[sed]?|mangle[sd]?)\b/i, "\x1b[1;33m"],
  [/\(\d+(?:\.\d+)? damage\)/, "\x1b[0;33m"],
  [/^(Your|You)\b.+\b(maul[s]?|wound[s]?|injure[sd]?|crush(?:es)?|bash(?:es)?|graze[sd]?|scratch(?:es)?|hit[s]?|miss(?:es)?|thrust[s]?)\b/i, "\x1b[0;33m"],
  [/\b(maul[s]?|wound[s]?|injure[sd]?|crush(?:es)?|bash(?:es)?|graze[sd]?|scratch(?:es)?|hit[s]?|miss(?:es)?)\b.+\byou[.!]/i, "\x1b[0;31m"],
  [/\butters? the words?,\s*'/i, "\x1b[0;35m"],
  [/\b(tell[s]? you,|clan[s]?,|shout[s]?,|yell[s]?,|say[s]?,|gossip[s]?,|chat[s]?,|auction[s]?)\s*'/i, "\x1b[1;36m"],
  [/^You (tell|clan|shout|yell|say|gossip|chat)\b/i, "\x1b[1;36m"],
  [/^Bloodbath System:/i, "\x1b[1;33m"],
  [/^TICK COMING SOON!/i, "\x1b[1;33m"],
  [/\d+%hp \d+%m \d+%mv/, "\x1b[0;36m"],
  [/^<\d+\/\d+hp /, "\x1b[0;36m"],
  [/^ \[[^\]]+\] \[.*?\] \[\d+:\d+[ap]m\]/, "\x1b[0;36m"],
  [/^You receive \d+ experience/, "\x1b[1;32m"],
  [/^The Gods give you/, "\x1b[1;32m"],
  [/^You get \d+/, "\x1b[0;32m"],
  [/^You are (surrounded by|protected by|blessed|bound by)/i, "\x1b[0;32m"],
  [/^You (feel|quaff|drink|eat|are surrounded)\b/i, "\x1b[0;32m"],
  [/^You quaff\b/i, "\x1b[0;32m"],
];

function colorize(line: string): string {
  if (!line.trim()) return line;
  for (const [re, open] of COL_RULES) {
    if (re.test(line)) return `${open}${line}\x1b[0m`;
  }
  return line;
}

// ─── ANSI → BBCode ───────────────────────────────────────────────────────────

const ANSI_COLOR_NAMES: Record<number, string> = {
  30: "BLACK", 31: "RED", 32: "GREEN", 33: "YELLOW", 34: "BLUE",
  35: "MAGENTA", 36: "CYAN", 37: "WHITE",
  90: "BROWN", 91: "ORANGE", 92: "LIME GREEN", 93: "YELLOW",
  94: "BLUE", 95: "MAGENTA", 96: "CYAN", 97: "WHITE",
};

function ansiToBBCode(line: string): string {
  const esc = /\x1b\[([0-9;]+)m/g;
  let out = "", last = 0, open: string | null = null;
  const pick = (codes: number[]) => {
    const bright = codes.find(c => 90 <= c && c <= 97); if (bright !== undefined) return bright;
    const basic  = codes.find(c => 30 <= c && c <= 37); if (basic  !== undefined) return basic;
    return undefined;
  };
  let m: RegExpExecArray | null;
  while ((m = esc.exec(line))) {
    out += line.slice(last, m.index);
    const codes = m[1].split(";").map(Number);
    if (codes.includes(0) && open) { out += "[/COLOR]"; open = null; }
    const col = pick(codes);
    if (col !== undefined) {
      const name = ANSI_COLOR_NAMES[col];
      if (name && line.charAt(esc.lastIndex) !== "]") {
        if (open) out += "[/COLOR]";
        out += `[COLOR=${name}]`; open = name;
      }
    }
    last = esc.lastIndex;
  }
  out += line.slice(last);
  if (open) out += "[/COLOR]";
  return out;
}

// ─── xterm helpers ───────────────────────────────────────────────────────────

function safeFit(addon: FitAddon | null, t: Terminal | null, el: HTMLElement | null) {
  if (!addon || !t || !el || !t.element || !el.isConnected) return;
  if (el.clientWidth <= 0 || el.clientHeight <= 0) return;
  try { addon.fit(); } catch {}
}

// ─── Damage-tracking renderer ─────────────────────────────────────────────────

const ROUND_GAP_MS  = 4_000;       // 4 s gap = new round (timestamped logs)
const FIGHT_GAP_MS  = 5 * 60_000;  // 5 min gap = new fight (timestamped logs)

/** MUD prompt patterns that signal end-of-round in plain text */
const PROMPT_RE = /\d+%hp|\d+%m |\d+%mv|^<\d+\/\d+hp /;

interface DmgTracker {
  round: DmgEvent[];
  fight: DmgEvent[];
  lastDmgTs: number | null;
  hadRoundDmg: boolean;
}

function newTracker(): DmgTracker {
  return { round: [], fight: [], lastDmgTs: null, hadRoundDmg: false };
}

function flushRound(t: Terminal, tracker: DmgTracker) {
  if (tracker.round.length === 0) return;
  const lines = buildRoundSummaryLines(tracker.round);
  for (const l of lines) t.writeln(l);
  t.writeln("");
  tracker.fight.push(...tracker.round);
  tracker.round = [];
  tracker.hadRoundDmg = false;
}

function flushFight(t: Terminal, tracker: DmgTracker) {
  flushRound(t, tracker);
  if (tracker.fight.length === 0) return;
  const lines = buildFightSummaryLines(tracker.fight);
  for (const l of lines) t.writeln(l);
  t.writeln("");
  tracker.fight = [];
  tracker.lastDmgTs = null;
}

/**
 * Renders one entry to the terminal, handling damage annotations and
 * emitting round/fight summaries at the right moments.
 *
 * Returns the text string that was written (used for BBCode/plain copy).
 */
function renderEntryTracked(
  t: Terminal,
  entry: Entry,
  format: Format,
  tracker: DmgTracker,
): void {
  const plain = stripAnsi(entry.text);
  const ts = entry.ts;

  // Timestamped gap checks (fire BEFORE writing the current line)
  if (ts !== undefined && tracker.lastDmgTs !== null) {
    const gap = ts - tracker.lastDmgTs;
    if (gap >= FIGHT_GAP_MS) {
      flushFight(t, tracker);
    } else if (gap >= ROUND_GAP_MS && tracker.hadRoundDmg) {
      flushRound(t, tracker);
    }
  }

  // parseDmgLine strips ANSI internally, so entry.text works for all formats
  const dmg = parseDmgLine(entry.text);

  if (dmg) {
    const src = dmgSource(plain, dmg.plainIndex);
    const tgt = dmgTarget(plain.slice(dmg.plainIndex + dmg.key.length));
    tracker.round.push({ source: src, target: tgt, key: dmg.key, value: dmg.value });
    tracker.hadRoundDmg = true;
    if (ts !== undefined) tracker.lastDmgTs = ts;

    let display: string;
    if (format === "rawlog") {
      // rawlog already has ANSI from the game server — append annotation only
      display = entry.text + dmgAnnotation(dmg.value);
    } else {
      // plain/mudlet: color only the damage keyword, not the whole line
      const col = dmgColor(dmg.value);
      display =
        entry.text.slice(0, dmg.plainIndex) +
        col + dmg.key + "\x1b[0m" +
        entry.text.slice(dmg.plainIndex + dmg.key.length) +
        dmgAnnotation(dmg.value);
    }
    t.writeln(display.length > 0 ? display : " ");
  } else {
    // Plain text round boundary: blank line or prompt after damage
    if (ts === undefined && tracker.hadRoundDmg) {
      if (!plain.trim() || PROMPT_RE.test(plain)) {
        flushRound(t, tracker);
      }
    }
    const raw = format === "rawlog" ? entry.text : colorize(entry.text);
    t.writeln(raw.length > 0 ? raw : " ");
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

const TICK_MS = 100;
const TICK_S  = 42;
const FORMAT_LABELS: Record<Format, string> = {
  rawlog: "DSL Raw Log (¤TS=…¤)",
  mudlet: "Mudlet timestamped",
  plain:  "Plain text",
};

const LogPasteViewer: FC = () => {
  // ── input state
  const [inputTab,  setInputTab]  = useState<"paste" | "file">("paste");
  const [pasteText, setPasteText] = useState("");

  // ── parsed log state
  const [parsed,   setParsed]   = useState<Parsed | null>(null);
  const [duration, setDuration] = useState(0);
  const [time,     setTime]     = useState(0);
  const [playing,  setPlaying]  = useState(false);

  // ── xterm refs
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef      = useRef<Terminal | null>(null);
  const fitRef       = useRef<FitAddon | null>(null);
  const timerRef     = useRef<number>(0);
  const lastIdxRef   = useRef(0);

  // ── damage tracking refs (persist across incremental renders)
  const trackerRef   = useRef<DmgTracker>(newTracker());
  const endFlushedRef = useRef(false);

  // ── init terminal
  useEffect(() => {
    const t = new Terminal({ convertEol: true } as any);
    const f = new FitAddon();
    t.loadAddon(f);
    termRef.current = t;
    fitRef.current  = f;
    const el = containerRef.current!;
    t.open(el);
    requestAnimationFrame(() => safeFit(f, t, el));
    t.writeln("⮞ Paste a log above, or load a file.");

    const onResize = () => safeFit(f, t, el);
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    const io = new IntersectionObserver(ents => { for (const en of ents) if (en.isIntersecting) safeFit(f, t, el); }, { threshold: 0.01 });
    io.observe(el);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      io.disconnect(); ro.disconnect();
      t.dispose(); termRef.current = null; fitRef.current = null;
    };
  }, []);

  // ── load parsed log
  const loadText = (text: string) => {
    const p = parseLog(text);
    setParsed(p);
    setTime(0);
    setPlaying(false);
    lastIdxRef.current = 0;
    trackerRef.current = newTracker();
    endFlushedRef.current = false;
    termRef.current?.clear();
    safeFit(fitRef.current, termRef.current, containerRef.current);

    if (!p.hasTimestamps) {
      // Render everything immediately — no playback for plain text
      const t = termRef.current!;
      const tracker = trackerRef.current;
      for (const entry of p.entries) {
        renderEntryTracked(t, entry, p.format, tracker);
      }
      // Flush any trailing round/fight at end of log
      flushFight(t, tracker);
      setDuration(0);
    } else {
      const last = p.entries[p.entries.length - 1].ts ?? 0;
      setDuration(last / 1000);
    }
  };

  const onPasteLoad  = () => { if (pasteText.trim()) loadText(pasteText); };
  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => loadText(r.result as string);
    r.readAsText(file);
  };

  // ── playback clock
  useEffect(() => {
    if (!playing) { clearInterval(timerRef.current); return; }
    let last = performance.now();
    timerRef.current = window.setInterval(() => {
      const now = performance.now();
      setTime(t => Math.min(t + (now - last) / 1000, duration));
      last = now;
    }, TICK_MS);
    return () => clearInterval(timerRef.current);
  }, [playing, duration]);

  // stop at end
  useEffect(() => { if (time >= duration && duration > 0 && playing) setPlaying(false); }, [time, duration, playing]);

  // ── render entries up to current time (playback mode)
  useEffect(() => {
    if (!parsed?.hasTimestamps || !parsed.entries.length) return;

    const cutoffMs = time * 1000;
    const nextIdx = parsed.entries.findIndex(e => (e.ts ?? 0) > cutoffMs);
    const end = nextIdx === -1 ? parsed.entries.length : nextIdx;

    // Backward seek: clear and re-render from scratch
    if (end < lastIdxRef.current) {
      termRef.current?.clear();
      lastIdxRef.current = 0;
      trackerRef.current = newTracker();
      endFlushedRef.current = false;
    }

    const t = termRef.current!;
    const tracker = trackerRef.current;

    for (let i = lastIdxRef.current; i < end; i++) {
      renderEntryTracked(t, parsed.entries[i], parsed.format, tracker);
    }
    lastIdxRef.current = end;

    // End-of-log flush
    if (end === parsed.entries.length && !endFlushedRef.current) {
      flushFight(t, tracker);
      endFlushedRef.current = true;
    }
    if (end !== parsed.entries.length) {
      endFlushedRef.current = false;
    }
  }, [time, parsed]);

  // ── copy helpers
  const stripAnsiLocal = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

  const copyPlainText = () => {
    if (!parsed) return;
    const lines = parsed.entries.map(e =>
      parsed.format === "rawlog"
        ? stripAnsiLocal(e.text)
        : stripAnsiLocal(colorize(e.text))
    );
    navigator.clipboard.writeText(lines.join("\n"));
  };

  const copyBBCode = () => {
    if (!parsed) return;
    const lines = parsed.entries.map(e =>
      parsed.format === "rawlog" ? ansiToBBCode(e.text) : ansiToBBCode(colorize(e.text))
    );
    navigator.clipboard.writeText(lines.join("\n"));
  };

  // ── popup "show whole log"
  const showWholeLog = () => {
    if (!parsed) return;
    const w = window.open("", "_blank", "width=900,height=700,scrollbars=yes,resizable=yes");
    if (!w) return;
    document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>("link[rel='stylesheet'], style")
      .forEach(n => w.document.head.appendChild(n.cloneNode(true)));
    Object.assign(w.document.body.style, { margin: "0", background: "#000" });
    const el = w.document.createElement("div");
    Object.assign(el.style, { width: "100%", height: "100vh" });
    w.document.body.appendChild(el);
    const t2 = new Terminal({ convertEol: true } as any);
    const f2 = new FitAddon();
    t2.loadAddon(f2);
    t2.open(el);
    const fit2 = () => { try { if (el.isConnected && el.clientWidth > 0) f2.fit(); } catch {} };
    w.requestAnimationFrame(fit2);
    const ro = new (w as any).ResizeObserver(fit2);
    ro.observe(el);
    w.addEventListener("beforeunload", () => ro.disconnect());

    const popupTracker = newTracker();
    for (const entry of parsed.entries) {
      renderEntryTracked(t2, entry, parsed.format, popupTracker);
    }
    flushFight(t2, popupTracker);
  };

  const fmtTime = (s: number) => new Date(s * 1000).toISOString().substr(11, 8);

  // ─── render ──────────────────────────────────────────────────────────────
  const hasData = parsed !== null;
  const showPlayback = hasData && (parsed?.hasTimestamps ?? false);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>

      {/* Input area */}
      <div style={{ background: "#1a1a1a", borderBottom: "1px solid #333", padding: "6px 8px", display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
        {/* Tab row */}
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {(["paste", "file"] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setInputTab(tab)}
              style={{
                background: inputTab === tab ? "#555" : "#2e2e2e",
                color: "#eee", border: "1px solid #444",
                padding: "2px 10px", cursor: "pointer", fontSize: 12,
              }}
            >
              {tab === "paste" ? "Paste Text" : "Load File"}
            </button>
          ))}
          {parsed && (
            <span style={{ marginLeft: 8, fontSize: 11, color: "#888" }}>
              Format: <span style={{ color: "#aef" }}>{FORMAT_LABELS[parsed.format]}</span>
              {" · "}{parsed.entries.length} lines
            </span>
          )}
        </div>

        {/* Paste tab */}
        {inputTab === "paste" && (
          <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
            <textarea
              value={pasteText}
              onChange={e => setPasteText(e.target.value)}
              placeholder="Paste your MUD log here…"
              style={{
                flex: 1, height: 72, resize: "vertical",
                background: "#111", color: "#ccc", border: "1px solid #444",
                fontFamily: "monospace", fontSize: 11, padding: 4,
              }}
            />
            <button
              onClick={onPasteLoad}
              style={{ background: "#3a5a3a", color: "#cfc", border: "1px solid #4a7a4a", padding: "4px 12px", cursor: "pointer" }}
            >
              Render
            </button>
          </div>
        )}

        {/* File tab */}
        {inputTab === "file" && (
          <input
            type="file"
            accept=".log,.txt,.jsonl"
            onChange={onFileChange}
            style={{ color: "#ccc" }}
          />
        )}

        {/* Toolbar */}
        {hasData && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={showWholeLog} style={btnStyle}>Show Whole Log</button>
            <button onClick={copyBBCode}   style={btnStyle}>Copy BBCode</button>
            <button onClick={copyPlainText} style={btnStyle}>Copy Plain Text</button>
            {showPlayback && (
              <>
                <button onClick={() => setPlaying(p => !p)} style={btnStyle}>
                  {playing ? "❚❚ Pause" : "▶ Play"}
                </button>
                <button onClick={() => setTime(t => Math.max(0, t - TICK_S))} style={btnStyle}>« {TICK_S}s</button>
                <button onClick={() => setTime(t => Math.min(duration, t + TICK_S))} style={btnStyle}>{TICK_S}s »</button>
                <button onClick={() => {
                  setPlaying(false);
                  setTime(0);
                  lastIdxRef.current = 0;
                  trackerRef.current = newTracker();
                  endFlushedRef.current = false;
                  termRef.current?.clear();
                }} style={btnStyle}>⏮ Reset</button>
                <span style={{ fontSize: 11, color: "#aaa" }}>
                  {fmtTime(time)} / {fmtTime(duration)}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Terminal */}
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, width: "100%", background: "#000" }}
      />
    </div>
  );
};

const btnStyle: CSSProperties = {
  background: "#2e2e2e", color: "#ddd", border: "1px solid #444",
  padding: "2px 8px", cursor: "pointer", fontSize: 12,
};

export default LogPasteViewer;
