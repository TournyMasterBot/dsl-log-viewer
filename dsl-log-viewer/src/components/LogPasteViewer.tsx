// src/components/LogPasteViewer.tsx
import { useState, useEffect, useRef, type CSSProperties, type ChangeEvent, type FC } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  parseDmgLine, dmgSource, dmgTarget, dmgColor, stripAnsi,
  dmgAnnotation, buildRoundSummaryLines, buildFightSummaryLines,
  ansiToHtml, buildHtmlPage,
  type DmgEvent,
} from "../damageParser";

// ─── Types ───────────────────────────────────────────────────────────────────

type Format = "rawlog" | "mudlet" | "plaintime" | "plain" | "ansi";

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
  const plaintimeHits = sample.filter(l => /^\d{2}:\d{2}:\d{2}[ap] \| /.test(l)).length;
  if (plaintimeHits >= Math.max(1, sample.length * 0.3)) return "plaintime";
  // Detect ANSI color sequences — with ESC byte (\x1b[) OR ESC-stripped (literal [1;31m)
  const ansiHits = sample.filter(l => /\x1b\[/.test(l) || /\[[0-9;]+m/.test(l)).length;
  if (ansiHits >= Math.max(1, sample.length * 0.1)) return "ansi";
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

// Plain text with timestamps: "HH:MM:SSa|p | content"
// 'a' = AM, 'p' = PM (12-hour clock). Content may have bare ANSI bracket sequences.
function parsePlaintime(text: string): Entry[] {
  const entries: Entry[] = [];
  let baseMs: number | null = null;
  let lastTs = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\d{2}):(\d{2}):(\d{2})([ap]) \| (.*)/);
    if (!m) {
      if (entries.length > 0) entries.push({ ts: lastTs, text: "" });
      continue;
    }
    let h = parseInt(m[1]);
    const min = parseInt(m[2]);
    const sec = parseInt(m[3]);
    const isPm = m[4] === "p";
    // 12-hour → 24-hour conversion
    if (isPm && h !== 12) h += 12;
    else if (!isPm && h === 12) h = 0;
    const totalMs = h * 3_600_000 + min * 60_000 + sec * 1_000;
    if (baseMs === null) baseMs = totalMs;
    let offset = totalMs - baseMs;
    if (offset < 0) offset += 86_400_000; // midnight rollover
    lastTs = offset;
    const content = m[5].replace(/(?<!\x1b)\[([0-9;]*)m/g, "\x1b[$1m");
    entries.push({ ts: offset, text: content });
  }
  return entries;
}

// Plain text: no timestamps, each line is one entry
function parsePlain(text: string): Entry[] {
  return text.split(/\r?\n/).map(line => ({ text: line }));
}

// ANSI plain text: same as plain but restores the ESC byte that some loggers strip.
// Handles both already-correct \x1b[ sequences and bare [N;Nm bracket sequences.
function parseAnsi(text: string): Entry[] {
  return text.split(/\r?\n/).map(line => ({
    // Add \x1b before any [N;Nm that isn't already preceded by \x1b
    text: line.replace(/(?<!\x1b)\[([0-9;]*)m/g, "\x1b[$1m"),
  }));
}

function parseLog(text: string): Parsed {
  const format = detectFormat(text);
  const entries =
    format === "rawlog"     ? parseRawlog(text) :
    format === "mudlet"     ? parseMudlet(text) :
    format === "plaintime"  ? parsePlaintime(text) :
    format === "ansi"       ? parseAnsi(text) :
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

// ─── DSL color codes ─────────────────────────────────────────────────────────

const DSL_COLOR_HEX: Record<string, string> = {
  "{r": "#800000", "{R": "#FF0000",
  "{y": "#808000", "{Y": "#FFFF00",
  "{b": "#00BFFF", "{B": "#0000FF",
  "{c": "#008080", "{C": "#00FFFF",
  "{m": "#8B008B", "{M": "#FF00FF",
  "{g": "#008000", "{G": "#00FF00",
  "{D": "#808080", "{W": "#FFFFFF",
  "{o": "#FF8040", "{p": "#FF80C0",
  "{n": "#804040", "{u": "#8E7CC3",
  "{w": "#C0C0C0",
};

const DSL_CODE_RE = /\{[rRyYbBcCmMgGDWopnuwx]/g;

function applyDslColors(line: string): string {
  return line.replace(DSL_CODE_RE, code => {
    if (code === "{x") return "\x1b[0m";
    const hex = DSL_COLOR_HEX[code];
    if (!hex) return code;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `\x1b[38;2;${r};${g};${b}m`;
  });
}

function stripDslCodes(line: string): string {
  return line.replace(DSL_CODE_RE, "");
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
    if (codes[0] === 38 && codes[1] === 2 && codes.length >= 5) {
      const toHex = (n: number) => n.toString(16).padStart(2, "0");
      const hex = `#${toHex(codes[2])}${toHex(codes[3])}${toHex(codes[4])}`;
      if (open) out += "[/COLOR]";
      out += `[COLOR=${hex}]`; open = hex;
    } else {
      const col = pick(codes);
      if (col !== undefined) {
        const name = ANSI_COLOR_NAMES[col];
        if (name && line.charAt(esc.lastIndex) !== "]") {
          if (open) out += "[/COLOR]";
          out += `[COLOR=${name}]`; open = name;
        }
      }
    }
    last = esc.lastIndex;
  }
  out += line.slice(last);
  if (open) out += "[/COLOR]";
  return out;
}

// ─── Clipboard text helper ───────────────────────────────────────────────────

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through */ }
  // execCommand fallback — works without clipboard-write permission
  const el = document.createElement("textarea");
  el.value = text;
  el.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.appendChild(el);
  el.focus();
  el.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(el);
  return ok;
}

// ─── PNG rendering ────────────────────────────────────────────────────────────

const ANSI_CANVAS_COLORS: Record<number, string> = {
  30: "#555555", 31: "#cc0000", 32: "#00aa00", 33: "#aa5500",
  34: "#0000cc", 35: "#aa00aa", 36: "#00aaaa", 37: "#aaaaaa",
  90: "#555555", 91: "#ff5555", 92: "#55ff55", 93: "#ffff55",
  94: "#5555ff", 95: "#ff55ff", 96: "#55ffff", 97: "#ffffff",
};

function renderAnsiLine(
  ctx: CanvasRenderingContext2D,
  line: string,
  x: number,
  y: number,
  defaultColor: string,
): void {
  const esc = /\x1b\[([0-9;]*)m/g;
  let last = 0, color = defaultColor;
  let m: RegExpExecArray | null;
  while ((m = esc.exec(line))) {
    if (m.index > last) {
      const seg = line.slice(last, m.index);
      ctx.fillStyle = color;
      ctx.fillText(seg, x, y);
      x += ctx.measureText(seg).width;
    }
    last = esc.lastIndex;
    const codes = m[1] ? m[1].split(";").map(Number) : [0];
    if (codes[0] === 0) {
      color = defaultColor;
    } else if (codes[0] === 38 && codes[1] === 2 && codes.length >= 5) {
      const h = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
      color = `#${h(codes[2])}${h(codes[3])}${h(codes[4])}`;
    } else {
      const fg = codes.find(c => (c >= 30 && c <= 37) || (c >= 90 && c <= 97));
      if (fg !== undefined) color = ANSI_CANVAS_COLORS[fg] ?? color;
    }
  }
  if (last < line.length) {
    ctx.fillStyle = color;
    ctx.fillText(line.slice(last), x, y);
  }
}

// ─── xterm helpers ───────────────────────────────────────────────────────────

function safeFit(addon: FitAddon | null, t: Terminal | null, el: HTMLElement | null) {
  if (!addon || !t || !el || !t.element || !el.isConnected) return;
  if (el.clientWidth <= 0 || el.clientHeight <= 0) return;
  try { addon.fit(); } catch {}
}

/** Middle-mouse autoscroll: single click activates, any click or Escape deactivates. */
function enableMiddleScroll(el: HTMLElement, t: Terminal): () => void {
  let active = false, originY = 0, currentY = 0, raf = 0;

  const indicator = document.createElement("div");
  Object.assign(indicator.style, {
    position: "fixed", zIndex: "99999", pointerEvents: "none",
    display: "none", transform: "translate(-50%, -50%)",
  });
  indicator.innerHTML = `<svg width="28" height="28" xmlns="http://www.w3.org/2000/svg">
    <circle cx="14" cy="14" r="12" fill="rgba(0,0,0,0.65)" stroke="#bbb" stroke-width="1.5"/>
    <polygon points="14,4 18,10 10,10" fill="#ddd"/>
    <polygon points="14,24 18,18 10,18" fill="#ddd"/>
    <line x1="8" y1="14" x2="20" y2="14" stroke="#888" stroke-width="1"/>
  </svg>`;
  document.body.appendChild(indicator);

  const tick = () => {
    if (!active) return;
    const delta = currentY - originY;
    const dead = 12;
    if (Math.abs(delta) > dead) {
      const lines = (delta - Math.sign(delta) * dead) / 35;
      t.scrollLines(lines > 0 ? Math.ceil(lines) : Math.floor(lines));
    }
    raf = requestAnimationFrame(tick);
  };

  const activate = (cx: number, cy: number) => {
    active = true; originY = currentY = cy;
    indicator.style.display = "block";
    indicator.style.left = cx + "px";
    indicator.style.top  = cy + "px";
    document.body.style.cursor = "none";
    cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
  };

  const deactivate = () => {
    active = false;
    indicator.style.display = "none";
    document.body.style.cursor = "";
    cancelAnimationFrame(raf);
  };

  const onDown = (e: MouseEvent) => {
    if (e.button === 1 && el.contains(e.target as Node)) {
      e.preventDefault();
      active ? deactivate() : activate(e.clientX, e.clientY);
      return;
    }
    if (active) deactivate();
  };
  const onMove = (e: MouseEvent) => { currentY = e.clientY; };
  const onKey  = (e: KeyboardEvent) => { if (active && e.key === "Escape") deactivate(); };

  window.addEventListener("mousedown", onDown, { capture: true });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("keydown",   onKey);
  return () => {
    window.removeEventListener("mousedown", onDown, { capture: true });
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("keydown",   onKey);
    cancelAnimationFrame(raf);
    indicator.remove();
  };
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

interface RenderOpts {
  skipAll:    boolean;  // skip inline annotations + round summaries + fight summaries
  skipRounds: boolean;  // skip round summaries only (fight summary still shown)
  skipInline: boolean;  // skip inline damage annotations only
  dslColors:  boolean;  // render DSL {x color codes as true color
}

const DEFAULT_OPTS: RenderOpts = { skipAll: false, skipRounds: false, skipInline: false, dslColors: false };

function newTracker(): DmgTracker {
  return { round: [], fight: [], lastDmgTs: null, hadRoundDmg: false };
}

function flushRound(t: Terminal, tracker: DmgTracker, emit: boolean) {
  if (tracker.round.length === 0) return;
  if (emit) {
    const lines = buildRoundSummaryLines(tracker.round);
    for (const l of lines) t.writeln(l);
    t.writeln("");
  }
  tracker.fight.push(...tracker.round);
  tracker.round = [];
  tracker.hadRoundDmg = false;
}

function flushFight(t: Terminal, tracker: DmgTracker, opts: RenderOpts = DEFAULT_OPTS) {
  const emitRound = !opts.skipAll && !opts.skipRounds;
  flushRound(t, tracker, emitRound);
  if (tracker.fight.length === 0) return;
  if (!opts.skipAll) {
    const lines = buildFightSummaryLines(tracker.fight);
    for (const l of lines) t.writeln(l);
    t.writeln("");
  }
  tracker.fight = [];
  tracker.lastDmgTs = null;
}

function renderEntryTracked(
  t: Terminal,
  entry: Entry,
  format: Format,
  tracker: DmgTracker,
  opts: RenderOpts = DEFAULT_OPTS,
): void {
  const isDslPlain = opts.dslColors && format === "plain";
  const text = isDslPlain ? applyDslColors(entry.text) : entry.text;
  const effectiveFormat: Format = isDslPlain ? "ansi" : format;

  const plain = stripAnsi(text);
  const ts = entry.ts;

  // Timestamped gap checks (fire BEFORE writing the current line)
  if (ts !== undefined && tracker.lastDmgTs !== null) {
    const gap = ts - tracker.lastDmgTs;
    if (gap >= FIGHT_GAP_MS) {
      flushFight(t, tracker, opts);
    } else if (gap >= ROUND_GAP_MS && tracker.hadRoundDmg) {
      flushRound(t, tracker, !opts.skipAll && !opts.skipRounds);
    }
  }

  const dmg = parseDmgLine(text);

  if (dmg) {
    const src = dmgSource(plain, dmg.plainIndex);
    const tgt = dmgTarget(plain.slice(dmg.plainIndex + dmg.key.length));
    tracker.round.push({ source: src, target: tgt, key: dmg.key, value: dmg.value });
    tracker.hadRoundDmg = true;
    if (ts !== undefined) tracker.lastDmgTs = ts;

    const annotation = (opts.skipAll || opts.skipInline) ? "" : dmgAnnotation(dmg.value);
    let display: string;
    if (effectiveFormat === "rawlog" || effectiveFormat === "ansi") {
      display = text + annotation;
    } else {
      const col = dmgColor(dmg.value);
      display =
        plain.slice(0, dmg.plainIndex) +
        col + dmg.key + "\x1b[0m" +
        plain.slice(dmg.plainIndex + dmg.key.length) +
        annotation;
    }
    t.writeln(display.length > 0 ? display : " ");
  } else {
    if (ts === undefined && tracker.hadRoundDmg) {
      if (!plain.trim() || PROMPT_RE.test(plain)) {
        flushRound(t, tracker, !opts.skipAll && !opts.skipRounds);
      }
    }
    const raw = (effectiveFormat === "rawlog" || effectiveFormat === "ansi") ? text : colorize(text);
    t.writeln(raw.length > 0 ? raw : " ");
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

const TICK_MS = 100;
const TICK_S  = 42;
const FORMAT_LABELS: Record<Format, string> = {
  rawlog:    "DSL Raw Log (¤TS=…¤)",
  mudlet:    "Mudlet timestamped",
  plaintime: "Plain text (HH:MM:SSa|p)",
  plain:     "Plain text",
  ansi:      "Plain text (ANSI colors)",
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

  // ── render options (checkboxes)
  const [skipAll,       setSkipAll]       = useState(false);
  const [skipRounds,    setSkipRounds]    = useState(false);
  const [skipInline,    setSkipInline]    = useState(false);
  const [dslColorCodes, setDslColorCodes] = useState(false);

  // ── copy feedback
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const markCopied = (key: string) => {
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // ── damage tracking refs (persist across incremental renders)
  const trackerRef    = useRef<DmgTracker>(newTracker());
  const endFlushedRef = useRef(false);
  const prevOptsRef   = useRef<RenderOpts>(DEFAULT_OPTS);

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
    const cleanupScroll = enableMiddleScroll(el, t);
    return () => {
      window.removeEventListener("resize", onResize);
      io.disconnect(); ro.disconnect();
      cleanupScroll();
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
      setDuration(0);
      // Rendering handled by the non-timestamped useEffect below
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

  // ── render non-timestamped logs (re-runs when opts change)
  useEffect(() => {
    if (!parsed || parsed.hasTimestamps) return;
    const t = termRef.current!;
    t.clear();
    const tracker = newTracker();
    trackerRef.current = tracker;
    const opts: RenderOpts = { skipAll, skipRounds, skipInline, dslColors: dslColorCodes };
    for (const entry of parsed.entries) {
      renderEntryTracked(t, entry, parsed.format, tracker, opts);
    }
    flushFight(t, tracker, opts);
  }, [parsed, skipAll, skipRounds, skipInline, dslColorCodes]);

  // ── render entries up to current time (playback mode)
  useEffect(() => {
    if (!parsed?.hasTimestamps || !parsed.entries.length) return;

    const opts: RenderOpts = { skipAll, skipRounds, skipInline, dslColors: dslColorCodes };
    const prev = prevOptsRef.current;
    const optsChanged =
      opts.skipAll !== prev.skipAll ||
      opts.skipRounds !== prev.skipRounds ||
      opts.skipInline !== prev.skipInline ||
      opts.dslColors !== prev.dslColors;
    prevOptsRef.current = opts;

    const cutoffMs = time * 1000;
    const nextIdx = parsed.entries.findIndex(e => (e.ts ?? 0) > cutoffMs);
    const end = nextIdx === -1 ? parsed.entries.length : nextIdx;

    // Backward seek or opts changed: clear and re-render from scratch
    if (end < lastIdxRef.current || optsChanged) {
      termRef.current?.clear();
      lastIdxRef.current = 0;
      trackerRef.current = newTracker();
      endFlushedRef.current = false;
    }

    const t = termRef.current!;
    const tracker = trackerRef.current;

    for (let i = lastIdxRef.current; i < end; i++) {
      renderEntryTracked(t, parsed.entries[i], parsed.format, tracker, opts);
    }
    lastIdxRef.current = end;

    // End-of-log flush
    if (end === parsed.entries.length && !endFlushedRef.current) {
      flushFight(t, tracker, opts);
      endFlushedRef.current = true;
    }
    if (end !== parsed.entries.length) {
      endFlushedRef.current = false;
    }
  }, [time, parsed, skipAll, skipRounds, skipInline, dslColorCodes]);

  // ── copy / download helpers

  const downloadFile = (content: string, filename: string, mime = "text/plain;charset=utf-8") => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  };

  /** Writes text to clipboard; falls back to a file download if the API fails or the payload is too large. */
  const safeWrite = async (content: string, filename: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    }
  };

  const useRaw = (fmt: Format) => fmt === "rawlog" || fmt === "ansi";

  const prepareText = (e: Entry): string => {
    if (!parsed) return e.text;
    if (useRaw(parsed.format)) return e.text;
    if (dslColorCodes) return applyDslColors(e.text);
    return colorize(e.text);
  };

  const copyPlainText = async () => {
    if (!parsed) return;
    const lines = parsed.entries.map(e => {
      if (dslColorCodes) return stripDslCodes(stripAnsi(e.text));
      return stripAnsi(useRaw(parsed.format) ? e.text : colorize(e.text));
    });
    const text = lines.join("\n");
    if (await copyTextToClipboard(text)) markCopied("plain");
    else downloadFile(text, "log.txt");
  };

  const copyBBCode = async () => {
    if (!parsed) return;
    const text = parsed.entries.map(e => ansiToBBCode(prepareText(e))).join("\n");
    if (await copyTextToClipboard(text)) markCopied("bbcode");
    else downloadFile(text, "log-bbcode.txt");
  };

  const downloadBBCode = () => {
    if (!parsed) return;
    const lines = parsed.entries.map(e => ansiToBBCode(prepareText(e)));
    downloadFile(lines.join("\n"), "log-bbcode.txt");
  };

  const copyHtml = async () => {
    if (!parsed) return;
    const htmlLines = parsed.entries.map(e => ansiToHtml(prepareText(e)));
    const fragment = `<pre style="background:#111;color:#ccc;font-family:'Courier New',Courier,monospace;font-size:13px;line-height:1.4;padding:8px;white-space:pre-wrap">\n${htmlLines.join("\n")}\n</pre>`;
    if (await copyTextToClipboard(fragment)) markCopied("html");
    else downloadFile(buildHtmlPage(htmlLines), "log.html", "text/html;charset=utf-8");
  };

  const downloadHtml = () => {
    if (!parsed) return;
    const htmlLines = parsed.entries.map(e => ansiToHtml(prepareText(e)));
    downloadFile(buildHtmlPage(htmlLines), "log.html", "text/html;charset=utf-8");
  };

  // ── PNG export
  const copyAsImage = () => {
    if (!parsed) return;
    const fontSize = 13;
    const lineHeightPx = Math.round(fontSize * 1.5);
    const paddingPx = 12;
    const bgColor = "#111111";
    const defaultColor = "#cccccc";
    const fontSpec = `${fontSize}px "Courier New", Courier, monospace`;

    const lines = parsed.entries.map(e => prepareText(e));
    const plainLines = lines.map(l => stripAnsi(l));

    const tmp = document.createElement("canvas");
    const tmpCtx = tmp.getContext("2d")!;
    tmpCtx.font = fontSpec;
    const charW = tmpCtx.measureText("X").width;

    const maxLen = Math.max(1, ...plainLines.map(l => l.length));
    const canvasW = Math.ceil(maxLen * charW) + paddingPx * 2;
    const canvasH = lines.length * lineHeightPx + paddingPx * 2;

    const canvas = document.createElement("canvas");
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d")!;

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvasW, canvasH);
    ctx.font = fontSpec;
    ctx.textBaseline = "top";

    for (let i = 0; i < lines.length; i++) {
      renderAnsiLine(ctx, lines[i], paddingPx, paddingPx + i * lineHeightPx, defaultColor);
    }

    canvas.toBlob(async blob => {
      if (!blob) return;
      let copied = false;
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        copied = true;
      } catch { /* fall through to download */ }
      if (copied) {
        markCopied("image");
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "log.png";
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
      }
    }, "image/png");
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

    const opts: RenderOpts = { skipAll, skipRounds, skipInline, dslColors: dslColorCodes };
    const popupTracker = newTracker();
    for (const entry of parsed.entries) {
      renderEntryTracked(t2, entry, parsed.format, popupTracker, opts);
    }
    flushFight(t2, popupTracker, opts);
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
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <button
                onClick={onPasteLoad}
                style={{ background: "#3a5a3a", color: "#cfc", border: "1px solid #4a7a4a", padding: "4px 12px", cursor: "pointer" }}
              >
                Render
              </button>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#bbb", cursor: "pointer", userSelect: "none" }}>
                <input type="checkbox" checked={dslColorCodes} onChange={e => setDslColorCodes(e.target.checked)} style={{ cursor: "pointer" }} />
                DSL color codes
              </label>
            </div>
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
            <button onClick={showWholeLog}   style={btnStyle}>Show Whole Log</button>
            <button onClick={copyHtml}       style={btnStyle}>{copiedKey === "html"   ? "✓ Copied!" : "Copy HTML"}</button>
            <button onClick={downloadHtml}   style={btnStyle}>Download HTML</button>
            <button onClick={copyBBCode}     style={btnStyle}>{copiedKey === "bbcode" ? "✓ Copied!" : "Copy BBCode"}</button>
            <button onClick={downloadBBCode} style={btnStyle}>Download BBCode</button>
            <button onClick={copyPlainText}  style={btnStyle}>{copiedKey === "plain"  ? "✓ Copied!" : "Copy Plain Text"}</button>
            <button onClick={copyAsImage}    style={btnStyle}>{copiedKey === "image"  ? "✓ Copied!" : "Copy as Image"}</button>
            <span style={{ marginLeft: 4, borderLeft: "1px solid #444", paddingLeft: 8, display: "flex", gap: 12, alignItems: "center" }}>
              {([
                ["skipAll",    skipAll,    setSkipAll,    "Skip damage summaries"] as const,
                ["skipRounds", skipRounds, setSkipRounds, "Skip round summaries"]  as const,
                ["skipInline", skipInline, setSkipInline, "Skip inline summaries"] as const,
              ]).map(([id, val, set, label]) => (
                <label key={id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#bbb", cursor: "pointer", userSelect: "none" }}>
                  <input type="checkbox" checked={val} onChange={e => set(e.target.checked)} style={{ cursor: "pointer" }} />
                  {label}
                </label>
              ))}
            </span>
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
