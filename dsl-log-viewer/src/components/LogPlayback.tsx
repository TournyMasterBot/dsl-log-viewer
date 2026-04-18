// src/components/LogPlaybackXterm.tsx
import { useState, useEffect, useRef, ChangeEvent, FC } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  annotateRawData, buildFightSummaryLines, buildRoundSummaryLines,
  dmgColor, fmt1, ansiToHtml, buildHtmlPage, stripAnsi,
  parseDmgLine, dmgSource, dmgTarget, dmgAnnotation,
  type DmgEvent,
} from "../damageParser";

interface DamageActorRow {
  actor: string;
  totalAsSource: number;
  totalAsTarget: number;
  countAsSource: number;
  countAsTarget: number;
}

interface DamageEvent {
  raw: string;
  source: string;
  target: string;
  verbKey: string;
  amount: number; // 0 => miss
}

interface DamagePayload {
  totalDamage: number;
  hits: number;
  misses: number;
  events?: DamageEvent[];
  bySource?: DamageActorRow[];
  byTarget?: DamageActorRow[];
}

type EntryType = "dsl-message" | "damage" | "raw" | "client-input";

interface LogEntry {
  ts: Date;
  type: EntryType;
  message?: string;
  payload?: DamagePayload;
}

const tickTimer = 42;
const FIVE_MIN_MS  = 5 * 60 * 1000;
const ROUND_GAP_MS = 4_000;
const PROMPT_RE = /\d+%hp|\d+%m |\d+%mv|^<\d+\/\d+hp /;

/* Fit guards */
function safeFit(addon: FitAddon | null, t: Terminal | null, container: HTMLElement | null) {
  if (!addon || !t || !container) return;
  if (!t.element) return;
  if (!container.isConnected) return;
  const { clientWidth, clientHeight } = container;
  if (clientWidth <= 0 || clientHeight <= 0) return;
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

/* Strip the first leading "[ … ] " prefix, if present. */
function normalizeActor(name: string): string {
  return (name || "").replace(/^\s*\[[^\]]*]\s*/, "");
}

/* Parse JSONL — supports both formats:
   Old: dsl-message, damage
   New: game:remote-server:raw, game:client:input
   Only dsl-message lines are deduped; all other entries are kept verbatim. */
function parseLog(text: string): LogEntry[] {
  const raw: LogEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    const ts = new Date(obj.timestamp);

    if (obj.type === "dsl-message") {
      raw.push({ ts, type: "dsl-message", message: obj.payload ?? "" });
    } else if (obj.type === "damage") {
      raw.push({ ts, type: "damage", payload: obj.payload as DamagePayload });
    } else if (obj.type === "game:remote-server:raw") {
      const data: string = obj.payload?.data ?? "";
      if (data) raw.push({ ts, type: "raw", message: data });
    } else if (obj.type === "game:client:input") {
      try {
        const inp = typeof obj.payload === "string" ? JSON.parse(obj.payload) : obj.payload;
        if (inp?.type === "data" && inp?.data) {
          raw.push({ ts, type: "client-input", message: inp.data });
        }
      } catch { /* skip malformed */ }
    }
  }

  raw.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  const seen = new Set<string>();
  const out: LogEntry[] = [];
  for (const e of raw) {
    if (e.type === "dsl-message") {
      const key = `${e.ts.toISOString()}|${e.type}|${e.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(e);
  }
  return out;
}

/* ANSI → BBCode */
const ansiColorNames: Record<number, string> = {
  30: "BLACK", 31: "RED", 32: "GREEN", 33: "YELLOW", 34: "BLUE", 35: "MAGENTA", 36: "CYAN", 37: "WHITE",
  90: "BROWN", 91: "ORANGE", 92: "LIME GREEN", 93: "YELLOW", 94: "BLUE", 95: "MAGENTA", 96: "CYAN", 97: "WHITE",
  38: "PURPLE",
};
function ansiToBBCode(line: string): string {
  const esc = /\x1b\[([0-9;]+)m/g;
  let out = "", last = 0, open: string | null = null;
  const pick = (codes: number[]): number | string | undefined => {
    const bright = codes.find((c) => 90 <= c && c <= 97); if (bright !== undefined) return bright;
    const basic  = codes.find((c) => 30 <= c && c <= 37); if (basic  !== undefined) return basic;
    const i = codes.findIndex((c, idx) => c === 38 && codes[idx + 1] === 5);
    if (i !== -1) { const x = codes[i + 2]; if (x === 61) return "PURPLE"; return `XTERM-${x}`; }
    return undefined;
  };
  let m: RegExpExecArray | null;
  while ((m = esc.exec(line))) {
    out += line.slice(last, m.index);
    const codes = m[1].split(";").map(Number);
    if (codes.includes(0) && open) { out += "[/COLOR]"; open = null; }
    const col = pick(codes);
    if (col !== undefined) {
      const name = typeof col === "number" ? ansiColorNames[col] : col;
      if (name) {
        const nextChar = line.charAt(esc.lastIndex);
        if (nextChar !== "]") { if (open) out += "[/COLOR]"; out += `[COLOR=${name}]`; open = name; }
      }
    }
    last = esc.lastIndex;
  }
  out += line.slice(last);
  if (open) out += "[/COLOR]";
  return out;
}

// ─── Round summary helpers ────────────────────────────────────────────────────

const R      = '\x1b[0m';
const CYAN   = '\x1b[0;36m';
const YELLOW = '\x1b[0;33m';
const GRAY   = '\x1b[2;37m';
const MAGENTA= '\x1b[0;35m';

/** Build per-source/target round summary lines from a DamagePayload. */
function buildRoundLines(p: DamagePayload): string[] {
  const lines: string[] = [];

  // Collect events → source → { target → damage }
  type PerSrc = { damage: number; hits: number; misses: number; targets: Map<string, number> };
  const per = new Map<string, PerSrc>();
  const hasBySource = !!(p.bySource && p.bySource.length);

  if (hasBySource) {
    for (const row of p.bySource!) {
      const name = normalizeActor(row.actor || "");
      const cur = per.get(name) ?? { damage: 0, hits: 0, misses: 0, targets: new Map() };
      cur.damage += row.totalAsSource || 0;
      cur.hits += row.countAsSource || 0;
      per.set(name, cur);
    }
  }

  if (p.events && p.events.length) {
    for (const ev of p.events) {
      const name = normalizeActor(ev.source || "");
      const tgt  = normalizeActor(ev.target || "?");
      const cur  = per.get(name) ?? { damage: 0, hits: 0, misses: 0, targets: new Map() };
      if (!hasBySource && (ev.amount ?? 0) > 0) {
        cur.damage += ev.amount || 0;
        cur.hits   += 1;
        cur.targets.set(tgt, (cur.targets.get(tgt) ?? 0) + (ev.amount || 0));
      } else if ((ev.amount ?? 0) > 0) {
        cur.targets.set(tgt, (cur.targets.get(tgt) ?? 0) + (ev.amount || 0));
      }
      if ((ev.amount ?? 0) === 0) cur.misses += 1;
      per.set(name, cur);
    }
  }

  const arr = [...per.entries()].sort((a, b) => b[1].damage - a[1].damage);
  lines.push(`${CYAN}─── Round ──────────────────────────────${R}`);
  for (const [actor, agg] of arr) {
    lines.push(
      `  ${YELLOW}${actor}${R}: ${dmgColor(agg.damage)}${fmt1(agg.damage)}${R} dmg` +
      `  ${GRAY}·${R}  ${agg.hits} hits  ${GRAY}·${R}  ${agg.misses} misses`
    );
    const tgtsSorted = [...agg.targets.entries()].sort((a, b) => b[1] - a[1]);
    for (const [tgt, dmg] of tgtsSorted) {
      lines.push(`    ${GRAY}→${R} ${MAGENTA}${tgt}${R}: ${dmgColor(dmg)}${fmt1(dmg)}${R}`);
    }
  }
  // total
  const roundTotal = arr.reduce((s, [, a]) => s + a.damage, 0);
  const roundHits  = arr.reduce((s, [, a]) => s + a.hits, 0);
  const roundMisses= arr.reduce((s, [, a]) => s + a.misses, 0);
  lines.push(
    `  Total: ${dmgColor(roundTotal)}${fmt1(roundTotal)}${R} dmg` +
    `  ${GRAY}·${R}  ${roundHits} hits  ${GRAY}·${R}  ${roundMisses} misses`
  );
  lines.push(`${CYAN}───────────────────────────────────────${R}`);
  return lines;
}

/** Collect DmgEvent[] from a DamagePayload for fight-level aggregation. */
function payloadToDmgEvents(p: DamagePayload): DmgEvent[] {
  const events: DmgEvent[] = [];
  if (!p.events) return events;
  for (const ev of p.events) {
    events.push({
      source: normalizeActor(ev.source || "?"),
      target: normalizeActor(ev.target || "?"),
      key: ev.verbKey || "",
      value: ev.amount ?? 0,
    });
  }
  return events;
}

const LogPlaybackXterm: FC = () => {
  // state
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [duration, setDuration] = useState<number>(0);
  const [time, setTime] = useState<number>(0);
  const [playing, setPlaying] = useState<boolean>(false);
  const [playbackActive, setPlaybackActive] = useState<boolean>(false);
  const [skipAll,    setSkipAll]    = useState(false);
  const [skipRounds, setSkipRounds] = useState(false);
  const [skipInline, setSkipInline] = useState(false);

  // refs
  const termContainer = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const timer = useRef<number>(0);
  const lastIndexRef = useRef<number>(0);

  // fight batching
  const lastDamageTsRef = useRef<number | null>(null);
  const nextFlushDeadlineRef = useRef<number | null>(null);
  const fightFlushedByTimerRef = useRef<boolean>(false);

  // per-actor fight accumulation (source → stats)
  type PerActor = { damage: number; hits: number; misses: number; targets: Map<string, number> };
  const byActorRef = useRef<Map<string, PerActor>>(new Map());
  // raw DmgEvent list for fight summary (needed by buildFightSummaryLines)
  const fightEventsRef = useRef<DmgEvent[]>([]);
  // round-level tracking for new-format raw entries
  const rawRoundEventsRef  = useRef<DmgEvent[]>([]);
  const rawHadRoundDmgRef  = useRef<boolean>(false);

  const flushedFinalRef = useRef<boolean>(false);

  /** Render every entry (with round + fight summaries) into the given terminal. */
  const renderAllEntries = (t: Terminal, ents: LogEntry[], skipAll = false, skipRounds = false, skipInline = false) => {
    const fightEvents: DmgEvent[] = [];
    let roundEvents: DmgEvent[] = [];
    let lastDmgTs: number | null = null;
    let hadRoundDmg = false;

    const flushRound = () => {
      if (roundEvents.length === 0) return;
      if (!skipAll && !skipRounds) {
        for (const l of buildRoundSummaryLines(roundEvents)) t.writeln(l);
        t.writeln("");
      }
      fightEvents.push(...roundEvents);
      roundEvents = []; hadRoundDmg = false;
    };

    const flushFight = () => {
      flushRound();
      if (fightEvents.length === 0) return;
      if (!skipAll) {
        t.writeln("\x1b[1;36m— Fight summary —\x1b[0m");
        for (const l of buildFightSummaryLines(fightEvents)) t.writeln(l);
        t.writeln("");
      }
      fightEvents.length = 0; lastDmgTs = null;
    };

    for (const e of ents) {
      if (e.type === "raw") {
        const curTs = e.ts.getTime();
        if (lastDmgTs !== null) {
          const gap = curTs - lastDmgTs;
          if (gap >= FIVE_MIN_MS) flushFight();
          else if (gap >= ROUND_GAP_MS && hadRoundDmg) flushRound();
        }
        const rawMsg = e.message ?? "";
        let pos = 0;
        while (pos < rawMsg.length) {
          const nl = rawMsg.indexOf('\n', pos);
          const lineEnd = nl === -1 ? rawMsg.length : nl + 1;
          const line = rawMsg.slice(pos, lineEnd);
          const content = line.replace(/[\r\n]+$/, '');
          const suffix  = line.slice(content.length);
          const dmg = parseDmgLine(content);
          if (dmg) {
            const plain = stripAnsi(content);
            roundEvents.push({
              source: dmgSource(plain, dmg.plainIndex),
              target: dmgTarget(plain.slice(dmg.plainIndex + dmg.key.length)),
              key: dmg.key, value: dmg.value,
            });
            hadRoundDmg = true; lastDmgTs = curTs;
            t.write(content + (!skipAll && !skipInline ? dmgAnnotation(dmg.value) : '') + suffix);
          } else {
            const plain = stripAnsi(content);
            if (hadRoundDmg && (!plain.trim() || PROMPT_RE.test(plain))) flushRound();
            t.write(line);
          }
          pos = lineEnd; if (nl === -1) break;
        }
      } else if (e.type === "client-input") {
        t.write(`\x1b[2m> ${e.message}\x1b[0m\r\n`);
      } else if (e.type === "dsl-message") {
        const line = e.message ?? "";
        t.writeln(line === "" ? " " : line);
      } else if (e.type === "damage" && e.payload) {
        const curTs = e.ts.getTime();
        if (lastDmgTs !== null && curTs - lastDmgTs >= FIVE_MIN_MS) flushFight();
        if (!skipAll && !skipRounds) {
          for (const l of buildRoundLines(e.payload)) t.writeln(l);
        }
        fightEvents.push(...payloadToDmgEvents(e.payload));
        lastDmgTs = curTs;
        t.writeln("");
      }
    }
    flushFight();
  };

  /** Reset all playback-tracking refs to their initial state. */
  const resetPlaybackRefs = () => {
    lastIndexRef.current = 0;
    lastDamageTsRef.current = null;
    nextFlushDeadlineRef.current = null;
    fightFlushedByTimerRef.current = false;
    byActorRef.current.clear();
    fightEventsRef.current = [];
    rawRoundEventsRef.current = [];
    rawHadRoundDmgRef.current = false;
    flushedFinalRef.current = false;
  };

  // file load
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setEntries(parseLog(reader.result as string));
    reader.readAsText(file);
  };

  /** Writes text to clipboard; falls back to file download if the API fails. */
  const safeWrite = async (content: string, filename: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      downloadFile(content, filename);
    }
  };

  const downloadFile = (content: string, filename: string, mime = "text/plain;charset=utf-8") => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  };

  /**
   * Walks all entries in the same order as the playback renderer and produces
   * ANSI-tagged lines — including round summaries and fight summaries.
   * Callers convert to plain / BBCode / HTML as needed.
   */
  const collectAnsiLines = (skipAll = false, skipRounds = false, skipInline = false): string[] => {
    const lines: string[] = [];
    const fightEvents: DmgEvent[] = [];
    let roundEvents: DmgEvent[] = [];
    let lastDmgTs: number | null = null;
    let hadRoundDmg = false;

    const flushRound = () => {
      if (roundEvents.length === 0) return;
      if (!skipAll && !skipRounds) {
        for (const l of buildRoundSummaryLines(roundEvents)) lines.push(l);
        lines.push("");
      }
      fightEvents.push(...roundEvents);
      roundEvents = []; hadRoundDmg = false;
    };

    const flushFight = () => {
      flushRound();
      if (fightEvents.length === 0) return;
      if (!skipAll) {
        lines.push("\x1b[1;36m— Fight summary —\x1b[0m");
        for (const l of buildFightSummaryLines(fightEvents)) lines.push(l);
        lines.push("");
      }
      fightEvents.length = 0; lastDmgTs = null;
    };

    for (const e of entries) {
      if (e.type === "raw") {
        const curTs = e.ts.getTime();
        if (lastDmgTs !== null) {
          const gap = curTs - lastDmgTs;
          if (gap >= FIVE_MIN_MS) flushFight();
          else if (gap >= ROUND_GAP_MS && hadRoundDmg) flushRound();
        }
        for (const rawLine of (e.message ?? "").split(/\r?\n/)) {
          const dmg = parseDmgLine(rawLine);
          if (dmg) {
            const plain = stripAnsi(rawLine);
            roundEvents.push({
              source: dmgSource(plain, dmg.plainIndex),
              target: dmgTarget(plain.slice(dmg.plainIndex + dmg.key.length)),
              key: dmg.key, value: dmg.value,
            });
            hadRoundDmg = true; lastDmgTs = curTs;
            lines.push(rawLine + (!skipAll && !skipInline ? dmgAnnotation(dmg.value) : ''));
          } else {
            const plain = stripAnsi(rawLine);
            if (hadRoundDmg && (!plain.trim() || PROMPT_RE.test(plain))) flushRound();
            lines.push(rawLine);
          }
        }
      } else if (e.type === "client-input") {
        lines.push(`\x1b[2m> ${e.message ?? ""}\x1b[0m`);
      } else if (e.type === "dsl-message") {
        lines.push(e.message ?? "");
      } else if (e.type === "damage" && e.payload) {
        const curTs = e.ts.getTime();
        if (lastDmgTs !== null && curTs - lastDmgTs >= FIVE_MIN_MS) flushFight();
        if (!skipAll && !skipRounds) {
          for (const l of buildRoundLines(e.payload)) lines.push(l);
        }
        fightEvents.push(...payloadToDmgEvents(e.payload));
        lastDmgTs = curTs;
        lines.push("");
      }
    }
    flushFight();
    return lines;
  };

  // copy plain
  const copyPlainText = () => {
    if (!entries.length) return;
    safeWrite(collectAnsiLines(skipAll, skipRounds, skipInline).map(stripAnsi).join("\n"), "log.txt");
  };

  // init xterm
  useEffect(() => {
    term.current = new Terminal({ convertEol: true } as any);
    fit.current = new FitAddon();
    term.current.loadAddon(fit.current);
    const container = termContainer.current;
    if (container) {
      term.current.open(container);
      requestAnimationFrame(() => safeFit(fit.current, term.current, container));
      term.current.writeln("⮞ Ready to load .log…");

      const ro = new ResizeObserver(() => safeFit(fit.current, term.current, container));
      ro.observe(container);
      const io = new IntersectionObserver((ents) => {
        for (const en of ents) if (en.isIntersecting) safeFit(fit.current, term.current, container);
      }, { threshold: 0.01 });
      io.observe(container);

      const onResize = () => safeFit(fit.current, term.current, container);
      window.addEventListener("resize", onResize);
      const cleanupScroll = enableMiddleScroll(container, term.current);

      return () => {
        window.removeEventListener("resize", onResize);
        io.disconnect(); ro.disconnect();
        cleanupScroll();
        term.current?.dispose(); term.current = null; fit.current = null;
      };
    }
    return () => { term.current?.dispose(); term.current = null; fit.current = null; };
  }, []);

  // render full log on load; reset playback state
  useEffect(() => {
    if (!entries.length) return;
    const start = entries[0].ts.getTime();
    const end   = entries[entries.length - 1].ts.getTime();
    setDuration((end - start) / 1000);
    setTime(0);
    setPlaying(false);
    setPlaybackActive(false);
    resetPlaybackRefs();

    const t = term.current;
    if (t) {
      t.clear();
      renderAllEntries(t, entries, skipAll, skipRounds, skipInline);
    }
    safeFit(fit.current, term.current, termContainer.current);
  }, [entries]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-render when opts change (only outside playback)
  useEffect(() => {
    if (!entries.length || playbackActive) return;
    const t = term.current;
    if (t) {
      t.clear();
      renderAllEntries(t, entries, skipAll, skipRounds, skipInline);
    }
  }, [skipAll, skipRounds, skipInline]); // eslint-disable-line react-hooks/exhaustive-deps

  // playback clock
  useEffect(() => {
    if (playing) {
      let last = performance.now();
      timer.current = window.setInterval(() => {
        const now = performance.now();
        setTime((t) => Math.min(t + (now - last) / 1000, duration));
        last = now;
      }, 100);
    } else {
      clearInterval(timer.current);
    }
    return () => clearInterval(timer.current);
  }, [playing, duration]);

  /* Accumulate round data into per-actor fight map */
  const addRoundToActors = (p: DamagePayload) => {
    const map = byActorRef.current;
    const hasBySource = !!(p.bySource && p.bySource.length);

    if (hasBySource) {
      for (const row of p.bySource!) {
        const name = normalizeActor(row.actor || "");
        const cur = map.get(name) ?? { damage: 0, hits: 0, misses: 0, targets: new Map() };
        cur.damage += row.totalAsSource || 0;
        cur.hits   += row.countAsSource || 0;
        map.set(name, cur);
      }
    }

    if (p.events && p.events.length) {
      for (const ev of p.events) {
        const name = normalizeActor(ev.source || "");
        const tgt  = normalizeActor(ev.target || "?");
        const cur  = map.get(name) ?? { damage: 0, hits: 0, misses: 0, targets: new Map() };
        if (!hasBySource && (ev.amount ?? 0) > 0) {
          cur.damage += ev.amount || 0;
          cur.hits   += 1;
        }
        if ((ev.amount ?? 0) > 0) {
          cur.targets.set(tgt, (cur.targets.get(tgt) ?? 0) + (ev.amount || 0));
        }
        if ((ev.amount ?? 0) === 0) cur.misses += 1;
        map.set(name, cur);
      }
    }

    // Accumulate raw events for fight summary builder
    fightEventsRef.current.push(...payloadToDmgEvents(p));
  };

  const flushRawRound = (skipRounds = false) => {
    const events = rawRoundEventsRef.current;
    if (events.length === 0) return;
    const t = term.current;
    if (!skipRounds && t) {
      for (const l of buildRoundSummaryLines(events)) t.writeln(l);
      t.writeln("");
    }
    fightEventsRef.current.push(...events);
    rawRoundEventsRef.current = [];
    rawHadRoundDmgRef.current = false;
  };

  const flushFightSummary = (label = "— Fight summary —", skipAll = false, skipRounds = false) => {
    flushRawRound(skipRounds);
    const events = fightEventsRef.current;
    if (events.length === 0 && byActorRef.current.size === 0) return;

    if (!skipAll) {
      const t = term.current;
      if (t) {
        t.writeln(`\x1b[1;36m${label}\x1b[0m`);
        for (const l of buildFightSummaryLines(events)) t.writeln(l);
        t.writeln("");
      }
    }

    byActorRef.current.clear();
    fightEventsRef.current = [];
    rawRoundEventsRef.current = [];
    rawHadRoundDmgRef.current = false;
    lastDamageTsRef.current = null;
    nextFlushDeadlineRef.current = null;
    fightFlushedByTimerRef.current = true;
  };

  /* Playback render */
  useEffect(() => {
    if (!entries.length || !playbackActive) return;

    const base = entries[0].ts.getTime();
    const cutoff = base + time * 1000;
    const nextIdx = entries.findIndex((e) => e.ts.getTime() > cutoff);
    const end = nextIdx === -1 ? entries.length : nextIdx;

    // Backward seek
    if (end < lastIndexRef.current) {
      term.current?.clear();
      resetPlaybackRefs();
    }

    for (let i = lastIndexRef.current; i < end; i++) {
      const entry = entries[i];

      // New format: annotate damage + track round/fight summaries
      if (entry.type === "raw") {
        const curTs = entry.ts.getTime();
        if (lastDamageTsRef.current !== null) {
          const gap = curTs - lastDamageTsRef.current;
          if (gap >= FIVE_MIN_MS && (fightEventsRef.current.length > 0 || rawRoundEventsRef.current.length > 0)) {
            flushFightSummary("— Fight summary —", skipAll, skipRounds);
          } else if (gap >= ROUND_GAP_MS && rawHadRoundDmgRef.current) {
            flushRawRound(skipRounds);
          }
        }
        const rawMsg = entry.message ?? "";
        let pos = 0;
        while (pos < rawMsg.length) {
          const nl = rawMsg.indexOf('\n', pos);
          const lineEnd = nl === -1 ? rawMsg.length : nl + 1;
          const line = rawMsg.slice(pos, lineEnd);
          const content = line.replace(/[\r\n]+$/, '');
          const suffix  = line.slice(content.length);
          const dmg = parseDmgLine(content);
          if (dmg) {
            const plain = stripAnsi(content);
            rawRoundEventsRef.current.push({
              source: dmgSource(plain, dmg.plainIndex),
              target: dmgTarget(plain.slice(dmg.plainIndex + dmg.key.length)),
              key: dmg.key, value: dmg.value,
            });
            rawHadRoundDmgRef.current = true;
            lastDamageTsRef.current = curTs;
            nextFlushDeadlineRef.current = curTs + FIVE_MIN_MS;
            fightFlushedByTimerRef.current = false;
            term.current?.write(content + (!skipAll && !skipInline ? dmgAnnotation(dmg.value) : '') + suffix);
          } else {
            const plain = stripAnsi(content);
            if (rawHadRoundDmgRef.current && (!plain.trim() || PROMPT_RE.test(plain))) flushRawRound(skipRounds);
            term.current?.write(line);
          }
          pos = lineEnd; if (nl === -1) break;
        }
        continue;
      }

      // Player command annotation (dim)
      if (entry.type === "client-input") {
        term.current?.write(`\x1b[2m> ${entry.message}\x1b[0m\r\n`);
        continue;
      }

      if (entry.type === "dsl-message") {
        const line = entry.message ?? "";
        term.current?.writeln(line.length > 0 ? line : " ");
        continue;
      }

      if (entry.type === "damage" && entry.payload) {
        const p = entry.payload;
        const curTs = entry.ts.getTime();

        // Gap ≥ 5 min since previous damage → flush previous fight
        if (
          lastDamageTsRef.current !== null &&
          curTs - lastDamageTsRef.current >= FIVE_MIN_MS &&
          (byActorRef.current.size > 0 || fightEventsRef.current.length > 0)
        ) {
          flushFightSummary("— Fight summary —", skipAll, skipRounds);
        }

        // Emit round summary
        if (!skipAll && !skipRounds) {
          const roundLines = buildRoundLines(p);
          for (const l of roundLines) term.current?.writeln(l);
        }

        // Accumulate for fight
        addRoundToActors(p);

        lastDamageTsRef.current = curTs;
        nextFlushDeadlineRef.current = curTs + FIVE_MIN_MS;
        fightFlushedByTimerRef.current = false;

        term.current?.writeln("");
      }
    }

    lastIndexRef.current = end;

    // Time-based gap flush
    const hasPendingFight = byActorRef.current.size > 0 || fightEventsRef.current.length > 0 || rawRoundEventsRef.current.length > 0;
    if (
      nextFlushDeadlineRef.current !== null &&
      cutoff >= nextFlushDeadlineRef.current &&
      !fightFlushedByTimerRef.current &&
      hasPendingFight
    ) {
      flushFightSummary("— Fight summary —", skipAll, skipRounds);
    }

    // End-of-log flush
    if (end === entries.length && !flushedFinalRef.current) {
      if (byActorRef.current.size > 0 || fightEventsRef.current.length > 0 || rawRoundEventsRef.current.length > 0) {
        flushFightSummary("— Fight summary —", skipAll, skipRounds);
      }
      flushedFinalRef.current = true;
    }
    if (end !== entries.length) {
      flushedFinalRef.current = false;
    }
  }, [time, entries, playbackActive, skipAll, skipRounds, skipInline]); // eslint-disable-line react-hooks/exhaustive-deps

  // popup viewer
  const showWholeLog = () => {
    if (!entries.length) return;
    const w = window.open("", "_blank", "width=800,height=600,scrollbars=yes,resizable=yes");
    if (!w) return;

    document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')
      .forEach((n) => w.document.head.appendChild(n.cloneNode(true)));
    Object.assign(w.document.body.style, { margin: "0", background: "#000" });

    const container = w.document.createElement("div");
    Object.assign(container.style, { width: "100%", height: "100vh" });
    w.document.body.appendChild(container);

    const t2 = new Terminal({ convertEol: true } as any);
    const f2 = new FitAddon();
    t2.loadAddon(f2);
    t2.open(container);

    const fitPopup = () => { try { if (container.isConnected && container.clientWidth > 0 && container.clientHeight > 0) f2.fit(); } catch {} };
    w.requestAnimationFrame(fitPopup);
    const ro = new (w as any).ResizeObserver(fitPopup);
    ro.observe(container);
    w.addEventListener("beforeunload", () => ro.disconnect());

    renderAllEntries(t2, entries, skipAll, skipRounds, skipInline);
  };

  // copy as BBCode
  const copyAsBBCode = () => {
    if (!entries.length) return;
    safeWrite(collectAnsiLines(skipAll, skipRounds, skipInline).map(ansiToBBCode).join("\n"), "log-bbcode.txt");
  };

  // download helpers
  const downloadPlainText = () => {
    if (!entries.length) return;
    downloadFile(collectAnsiLines(skipAll, skipRounds, skipInline).map(stripAnsi).join("\n"), "log.txt");
  };

  const downloadBBCode = () => {
    if (!entries.length) return;
    downloadFile(collectAnsiLines(skipAll, skipRounds, skipInline).map(ansiToBBCode).join("\n"), "log-bbcode.txt");
  };

  const downloadHtml = () => {
    if (!entries.length) return;
    downloadFile(buildHtmlPage(collectAnsiLines(skipAll, skipRounds, skipInline).map(ansiToHtml)), "log.html", "text/html;charset=utf-8");
  };

  // copy as HTML
  const copyAsHtml = async () => {
    if (!entries.length) return;
    const htmlLines = collectAnsiLines(skipAll, skipRounds, skipInline).map(ansiToHtml);
    const fragment = `<pre style="background:#111;color:#ccc;font-family:'Courier New',Courier,monospace;font-size:13px;line-height:1.4;padding:8px;white-space:pre-wrap">\n${htmlLines.join("\n")}\n</pre>`;
    try {
      if (typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html":  new Blob([fragment], { type: "text/html" }),
            "text/plain": new Blob([fragment], { type: "text/plain" }),
          }),
        ]);
        return;
      }
    } catch { /* fall through */ }
    await safeWrite(buildHtmlPage(htmlLines), "log.html");
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: 8, background: "#222", color: "#fff", flexShrink: 0 }}>
        <input type="file" accept=".log,.txt,.jsonl" onChange={onFile} />
        {entries.length > 0 && (
          <>
            {(
              [
                ["skipAll",    skipAll,    setSkipAll,    "Skip damage summaries"] as const,
                ["skipRounds", skipRounds, setSkipRounds, "Skip round summaries"]  as const,
                ["skipInline", skipInline, setSkipInline, "Skip inline summaries"] as const,
              ] as const
            ).map(([id, val, setter, label]) => (
              <label key={id} style={{ marginLeft: 8 }}>
                <input type="checkbox" checked={val} onChange={e => setter(e.target.checked)} />{" "}{label}
              </label>
            ))}
            <button onClick={showWholeLog}>Show Whole Log</button>
            <button onClick={copyAsHtml}>Copy HTML</button>
            <button onClick={downloadHtml}>Download HTML</button>
            <button onClick={copyAsBBCode}>Copy BBCode</button>
            <button onClick={downloadBBCode}>Download BBCode</button>
            <button onClick={copyPlainText}>Copy Plain Text</button>
            <button onClick={downloadPlainText}>Download Plain Text</button>
            {!playbackActive ? (
              <button onClick={() => {
                term.current?.clear();
                resetPlaybackRefs();
                setTime(0);
                setPlaybackActive(true);
                setPlaying(true);
              }}>▶️ Start Playback</button>
            ) : (
              <>
                <button onClick={() => setPlaying((p) => !p)}>
                  {playing ? "❚❚ Pause" : "▶ Resume"}
                </button>
                <button onClick={() => setTime((t) => Math.max(0, t - tickTimer))}>
                  « {tickTimer}s
                </button>
                <button onClick={() => setTime((t) => Math.min(duration, t + tickTimer))}>
                  {tickTimer}s »
                </button>
                <button onClick={() => {
                  setPlaying(false);
                  setPlaybackActive(false);
                  const t = term.current;
                  if (t) { t.clear(); renderAllEntries(t, entries, skipAll, skipRounds, skipInline); }
                }}>⏮ Exit Playback</button>
                <span style={{ marginLeft: 12, color: "#aaa" }}>
                  {new Date(time * 1000).toISOString().slice(11, 19)} /{" "}
                  {new Date(duration * 1000).toISOString().slice(11, 19)}
                </span>
              </>
            )}
          </>
        )}
      </div>
      <div ref={termContainer} style={{ flex: 1, minHeight: 0, width: "100%", background: "#000" }} />
    </div>
  );
};

export default LogPlaybackXterm;
