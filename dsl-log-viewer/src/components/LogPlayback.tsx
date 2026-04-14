// src/components/LogPlaybackXterm.tsx
import { useState, useEffect, useRef, ChangeEvent, FC } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  annotateRawData, buildFightSummaryLines, dmgColor, fmt1,
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
const FIVE_MIN_MS = 5 * 60 * 1000;

/* Fit guards */
function safeFit(addon: FitAddon | null, t: Terminal | null, container: HTMLElement | null) {
  if (!addon || !t || !container) return;
  if (!t.element) return;
  if (!container.isConnected) return;
  const { clientWidth, clientHeight } = container;
  if (clientWidth <= 0 || clientHeight <= 0) return;
  try { addon.fit(); } catch {}
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

  const flushedFinalRef = useRef<boolean>(false);

  // file load
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setEntries(parseLog(reader.result as string));
    reader.readAsText(file);
  };

  // copy plain
  const copyPlainText = () => {
    if (!entries.length) return;
    const ansi = /\x1b\[[0-9;]*[A-Za-z]/g;
    const chunks: string[] = [];
    for (const e of entries) {
      if (e.type === "raw") {
        chunks.push((e.message ?? "").replace(ansi, ""));
      } else if (e.type === "client-input") {
        chunks.push(`> ${e.message ?? ""}`);
      } else if (e.type === "dsl-message") {
        chunks.push((e.message ?? "").replace(ansi, "") || " ");
      } else if (e.type === "damage" && e.payload) {
        const p = e.payload;
        chunks.push(`⮞ Damage Round: total=${p.totalDamage}, hits=${p.hits}, misses=${p.misses}`);
      }
    }
    navigator.clipboard.writeText(chunks.join("\n"));
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

      return () => {
        window.removeEventListener("resize", onResize);
        io.disconnect(); ro.disconnect();
        term.current?.dispose(); term.current = null; fit.current = null;
      };
    }
    return () => { term.current?.dispose(); term.current = null; fit.current = null; };
  }, []);

  // reset on new entries
  useEffect(() => {
    if (!entries.length) return;
    const start = entries[0].ts.getTime();
    const end = entries[entries.length - 1].ts.getTime();
    setDuration((end - start) / 1000);
    setTime(0);
    setPlaying(false);
    lastIndexRef.current = 0;
    term.current?.clear();

    lastDamageTsRef.current = null;
    nextFlushDeadlineRef.current = null;
    fightFlushedByTimerRef.current = false;
    byActorRef.current.clear();
    fightEventsRef.current = [];
    flushedFinalRef.current = false;

    safeFit(fit.current, term.current, termContainer.current);
  }, [entries]);

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

  const flushFightSummary = (label = "— Fight summary —") => {
    const events = fightEventsRef.current;
    if (events.length === 0 && byActorRef.current.size === 0) return;

    const t = term.current;
    if (!t) return;

    t.writeln(`\x1b[1;36m${label}\x1b[0m`);

    // Use the shared fight summary builder
    const summaryLines = buildFightSummaryLines(events);
    for (const l of summaryLines) t.writeln(l);
    t.writeln("");

    // reset fight
    byActorRef.current.clear();
    fightEventsRef.current = [];
    lastDamageTsRef.current = null;
    nextFlushDeadlineRef.current = null;
    fightFlushedByTimerRef.current = true;
  };

  /* Playback render */
  useEffect(() => {
    if (!entries.length) return;

    const base = entries[0].ts.getTime();
    const cutoff = base + time * 1000;
    const nextIdx = entries.findIndex((e) => e.ts.getTime() > cutoff);
    const end = nextIdx === -1 ? entries.length : nextIdx;

    // Backward seek
    if (end < lastIndexRef.current) {
      term.current?.clear();
      lastIndexRef.current = 0;
      lastDamageTsRef.current = null;
      nextFlushDeadlineRef.current = null;
      fightFlushedByTimerRef.current = false;
      byActorRef.current.clear();
      fightEventsRef.current = [];
      flushedFinalRef.current = false;
    }

    for (let i = lastIndexRef.current; i < end; i++) {
      const entry = entries[i];

      // New format: annotate damage lines in raw server output
      if (entry.type === "raw") {
        term.current?.write(annotateRawData(entry.message ?? ""));
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
          flushFightSummary("— Fight summary —");
        }

        // Emit round summary
        const roundLines = buildRoundLines(p);
        for (const l of roundLines) term.current?.writeln(l);

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
    if (
      nextFlushDeadlineRef.current !== null &&
      cutoff >= nextFlushDeadlineRef.current &&
      !fightFlushedByTimerRef.current &&
      (byActorRef.current.size > 0 || fightEventsRef.current.length > 0)
    ) {
      flushFightSummary("— Fight summary —");
    }

    // End-of-log flush
    if (end === entries.length && !flushedFinalRef.current) {
      if (byActorRef.current.size > 0 || fightEventsRef.current.length > 0) {
        flushFightSummary("— Fight summary —");
      }
      flushedFinalRef.current = true;
    }
    if (end !== entries.length) {
      flushedFinalRef.current = false;
    }
  }, [time, entries]);

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

    // Replay all entries with summaries into popup
    const popupFightEvents: DmgEvent[] = [];
    let popupLastDmgTs: number | null = null;

    entries.forEach((e) => {
      if (e.type === "raw") {
        t2.write(annotateRawData(e.message ?? ""));
      } else if (e.type === "client-input") {
        t2.write(`\x1b[2m> ${e.message}\x1b[0m\r\n`);
      } else if (e.type === "dsl-message") {
        const line = e.message ?? "";
        t2.writeln(line === "" ? " " : line);
      } else if (e.type === "damage" && e.payload) {
        const p = e.payload;
        const curTs = e.ts.getTime();

        if (popupLastDmgTs !== null && curTs - popupLastDmgTs >= FIVE_MIN_MS && popupFightEvents.length > 0) {
          t2.writeln(`\x1b[1;36m— Fight summary —\x1b[0m`);
          for (const l of buildFightSummaryLines(popupFightEvents)) t2.writeln(l);
          t2.writeln("");
          popupFightEvents.length = 0;
        }

        for (const l of buildRoundLines(p)) t2.writeln(l);
        popupFightEvents.push(...payloadToDmgEvents(p));
        popupLastDmgTs = curTs;
        t2.writeln("");
      }
    });

    // Final fight summary in popup
    if (popupFightEvents.length > 0) {
      t2.writeln(`\x1b[1;36m— Fight summary —\x1b[0m`);
      for (const l of buildFightSummaryLines(popupFightEvents)) t2.writeln(l);
      t2.writeln("");
    }
  };

  // copy as BBCode
  const copyAsBBCode = () => {
    if (!entries.length) return;
    const parts: string[] = [];
    for (const e of entries) {
      if (e.type === "raw") {
        parts.push(ansiToBBCode(e.message ?? ""));
      } else if (e.type === "client-input") {
        parts.push(`> ${e.message ?? ""}`);
      } else if (e.type === "dsl-message") {
        parts.push(ansiToBBCode(e.message ?? ""));
      } else if (e.type === "damage" && e.payload) {
        const p = e.payload;
        parts.push(`[B]Damage Round:[/B] total=${p.totalDamage}, hits=${p.hits}, misses=${p.misses}`);
        parts.push("");
      }
    }
    navigator.clipboard.writeText(parts.join("\n"));
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: 8, background: "#222", color: "#fff", flexShrink: 0 }}>
        <input type="file" accept=".log,.txt,.jsonl" onChange={onFile} />
        {entries.length > 0 && (
          <>
            <button onClick={showWholeLog}>Show Whole Log</button>
            <button onClick={copyAsBBCode}>Copy BBCode (Forum Color)</button>
            <button onClick={copyPlainText}>Copy Log (Plain Text)</button>
            <button onClick={() => setPlaying((p) => !p)}>
              {playing ? "❚❚ Pause" : "▶️ Start Playback"}
            </button>
            <button onClick={() => setTime((t) => Math.max(0, t - tickTimer))}>
              « {tickTimer}s
            </button>
            <button onClick={() => setTime((t) => Math.min(duration, t + tickTimer))}>
              {tickTimer}s »
            </button>
            <span style={{ marginLeft: 12, color: "#aaa" }}>
              {new Date(time * 1000).toISOString().slice(11, 19)} /{" "}
              {new Date(duration * 1000).toISOString().slice(11, 19)}
            </span>
          </>
        )}
      </div>
      <div ref={termContainer} style={{ flex: 1, minHeight: 0, width: "100%", background: "#000" }} />
    </div>
  );
};

export default LogPlaybackXterm;
