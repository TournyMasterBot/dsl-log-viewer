// src/components/LogPlaybackXterm.tsx
import React, { useState, useEffect, useRef, ChangeEvent, FC } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface DamageActorRow {
  actor: string;
  totalAsSource: number;
  totalAsTarget: number;
  countAsSource: number; // hits as source
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

type EntryType = "dsl-message" | "damage";

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

/* number → 1-decimal, drop trailing .0 */
function fmt1(n: number): string {
  const v = Math.round((n ?? 0) * 10) / 10;
  return Number.isFinite(v) ? (v % 1 === 0 ? String(v) : v.toFixed(1)) : "0";
}

/* Parse JSONL for dsl-message + damage
   CHANGE: Only dsl-message lines are deduped; damage rounds are kept verbatim. */
function parseLog(text: string): LogEntry[] {
  const raw: LogEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === "dsl-message") {
      raw.push({ ts: new Date(obj.timestamp), type: "dsl-message", message: obj.payload ?? "" });
    } else if (obj.type === "damage") {
      raw.push({ ts: new Date(obj.timestamp), type: "damage", payload: obj.payload as DamagePayload });
    }
  }

  raw.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  // Dedupe ONLY dsl-message; keep ALL damage rounds (prevents accidental drops)
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

/* ANSI → BBCode (unchanged) */
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
  const nextFlushDeadlineRef = useRef<number | null>(null); // absolute ms (log clock of next fight-summary moment)
  const fightFlushedByTimerRef = useRef<boolean>(false);

  type PerActor = { damage: number; hits: number; misses: number };
  const byActorRef = useRef<Map<string, PerActor>>(new Map());
  const totalsRef = useRef<{ damage: number; hits: number; misses: number }>({ damage: 0, hits: 0, misses: 0 });

  const flushedFinalRef = useRef<boolean>(false);

  // file load
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setEntries(parseLog(reader.result as string));
    reader.readAsText(file);
  };

  // copy plain (round headers + per-round per-source lines)
  const copyPlainText = () => {
    if (!entries.length) return;
    const ansi = /\x1b\[[0-9;]*[A-Za-z]/g;
    const chunks: string[] = [];
    for (const e of entries) {
      if (e.type === "dsl-message") {
        chunks.push((e.message ?? "").replace(ansi, "") || " ");
      } else if (e.type === "damage" && e.payload) {
        const p = e.payload;
        chunks.push(`⮞ Damage Round: total=${p.totalDamage}, hits=${p.hits}, misses=${p.misses}`);
        const lines = buildRoundPerSourceLines(p);
        if (lines.length) {
          chunks.push("By source:");
          lines.forEach(l => chunks.push(`  ${l}`));
        }
        chunks.push(""); // blank line
        chunks.push("");
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

    // reset fight state
    lastDamageTsRef.current = null;
    nextFlushDeadlineRef.current = null;
    fightFlushedByTimerRef.current = false;
    byActorRef.current.clear();
    totalsRef.current = { damage: 0, hits: 0, misses: 0 };
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

  /* Build per-round per-source lines */
  function buildRoundPerSourceLines(p: DamagePayload): string[] {
    const per = new Map<string, { damage: number; hits: number; misses: number }>();
    const hasBySource = !!(p.bySource && p.bySource.length);

    if (hasBySource) {
      for (const row of p.bySource!) {
        const name = normalizeActor(row.actor || "");
        const cur = per.get(name) ?? { damage: 0, hits: 0, misses: 0 };
        cur.damage += row.totalAsSource || 0;
        cur.hits += row.countAsSource || 0;
        per.set(name, cur);
      }
    }

    if (p.events && p.events.length) {
      for (const ev of p.events) {
        const name = normalizeActor(ev.source || "");
        const cur = per.get(name) ?? { damage: 0, hits: 0, misses: 0 };
        if (!hasBySource) {
          if ((ev.amount ?? 0) > 0) { cur.damage += ev.amount || 0; cur.hits += 1; }
        }
        if ((ev.amount ?? 0) === 0) { cur.misses += 1; }
        per.set(name, cur);
      }
    }

    const arr = [...per.entries()]
      .sort((a, b) => b[1].damage - a[1].damage || b[1].hits - a[1].hits)
      .map(([actor, agg]) => `${actor}: ${fmt1(agg.damage)} dmg, ${agg.hits} hits, ${agg.misses} misses`);
    return arr;
  }

  /* Fight batching helpers (with per-source misses) */
  const addRoundToActors = (p: DamagePayload) => {
    const map = byActorRef.current;
    const hasBySource = !!(p.bySource && p.bySource.length);

    if (hasBySource) {
      for (const row of p.bySource!) {
        const name = normalizeActor(row.actor || "");
        const cur = map.get(name) ?? { damage: 0, hits: 0, misses: 0 };
        cur.damage += row.totalAsSource || 0;
        cur.hits += row.countAsSource || 0;
        map.set(name, cur);
      }
    } else if (p.events && p.events.length) {
      for (const ev of p.events) {
        const name = normalizeActor(ev.source || "");
        const cur = map.get(name) ?? { damage: 0, hits: 0, misses: 0 };
        if (ev.amount > 0) { cur.damage += ev.amount || 0; cur.hits += 1; }
        map.set(name, cur);
      }
    }

    if (p.events && p.events.length) {
      for (const ev of p.events) {
        if ((ev.amount ?? 0) === 0) {
          const name = normalizeActor(ev.source || "");
          const cur = map.get(name) ?? { damage: 0, hits: 0, misses: 0 };
          cur.misses += 1;
          map.set(name, cur);
        }
      }
    }
  };

  const addRoundToTotals = (p: DamagePayload) => {
    // NOTE: Totals are derived from the same basis we use per-actor to avoid mismatches.
    const t = totalsRef.current;

    if (p.bySource?.length) {
      t.damage += p.bySource.reduce((s, r) => s + (r.totalAsSource || 0), 0);
      t.hits   += p.bySource.reduce((s, r) => s + (r.countAsSource || 0), 0);
    } else if (p.events?.length) {
      for (const ev of p.events) {
        if ((ev.amount ?? 0) > 0) { t.damage += ev.amount || 0; t.hits += 1; }
      }
    } else {
      // Fallback to payload rollups (rare)
      t.damage += p.totalDamage || 0;
      t.hits   += p.hits || 0;
    }

    if (p.events?.length) {
      t.misses += p.events.filter(e => (e.amount ?? 0) === 0).length;
    } else if (typeof p.misses === "number") {
      t.misses += p.misses;
    }
  };

  const flushFightSummary = (label = "— Fight summary —") => {
    const map = byActorRef.current;
    const t = totalsRef.current;
    if (map.size === 0 && t.damage === 0 && t.hits === 0 && t.misses === 0) return;

    term.current?.writeln(`${label} totalDamage=${fmt1(t.damage)}, hits=${t.hits}, misses=${t.misses}`);
    if (map.size > 0) {
      const rows = [...map.entries()].sort((a, b) => b[1].damage - a[1].damage);
      for (const [actor, agg] of rows) {
        term.current?.writeln(
          `  ${actor}: ${fmt1(agg.damage)} dmg, ${agg.hits} hits, ${agg.misses} misses`
        );
      }
    }
    term.current?.writeln("");

    // reset fight
    map.clear();
    totalsRef.current = { damage: 0, hits: 0, misses: 0 };
    lastDamageTsRef.current = null;
    nextFlushDeadlineRef.current = null;
    fightFlushedByTimerRef.current = true;
  };

  /* Playback render (incl. per-round per-source lines + time-gap flush)
     IMPORTANT for seeking/skips:
     - We process ALL entries between lastIndexRef and the new cutoff, so jumping forward
       (via » or dragging) counts every damage round crossed.
     - If the jump crosses a 5+ min gap *without* hitting the next damage line yet, the
       time-based flush below fires and prints the fight summary on time. */
  useEffect(() => {
    if (!entries.length) return;

    const base = entries[0].ts.getTime();
    const cutoff = base + time * 1000;
    const nextIdx = entries.findIndex((e) => e.ts.getTime() > cutoff);
    const end = nextIdx === -1 ? entries.length : nextIdx;

    // 1) Emit new entries up to cutoff
    for (let i = lastIndexRef.current; i < end; i++) {
      const entry = entries[i];

      if (entry.type === "dsl-message") {
        const line = entry.message ?? "";
        term.current?.writeln(line.length > 0 ? line : " ");
        continue;
      }

      if (entry.type === "damage" && entry.payload) {
        const p = entry.payload;
        const curTs = entry.ts.getTime();

        // If gap ≥ 5 min since previous damage, flush previous fight first
        if (
          lastDamageTsRef.current !== null &&
          curTs - lastDamageTsRef.current >= FIVE_MIN_MS &&
          (byActorRef.current.size > 0 || totalsRef.current.damage > 0 || totalsRef.current.hits > 0 || totalsRef.current.misses > 0)
        ) {
          flushFightSummary("— Fight summary —");
        }

        // Round header
        term.current?.writeln(`⮞ Damage Round: total=${p.totalDamage}, hits=${p.hits}, misses=${p.misses}`);

        // Per-round per-source lines
        const lines = buildRoundPerSourceLines(p);
        if (lines.length) {
          term.current?.writeln("By source:");
          lines.forEach(l => term.current?.writeln(`  ${l}`));
        }

        // Accumulate for fight
        addRoundToActors(p);
        addRoundToTotals(p);

        // Timers
        lastDamageTsRef.current = curTs;
        nextFlushDeadlineRef.current = curTs + FIVE_MIN_MS;
        fightFlushedByTimerRef.current = false;

        // Spacing
        term.current?.writeln("");
        term.current?.writeln("");
      }
    }

    lastIndexRef.current = end;

    // 2) Time-based gap flush (no new entries required)
    if (
      nextFlushDeadlineRef.current !== null &&
      cutoff >= nextFlushDeadlineRef.current &&
      !fightFlushedByTimerRef.current &&
      (byActorRef.current.size > 0 || totalsRef.current.damage > 0 || totalsRef.current.hits > 0 || totalsRef.current.misses > 0)
    ) {
      flushFightSummary("— Fight summary —");
    }

    // 3) End-of-log flush
    if (end === entries.length && !flushedFinalRef.current) {
      if (byActorRef.current.size > 0 || totalsRef.current.damage > 0 || totalsRef.current.hits > 0 || totalsRef.current.misses > 0) {
        flushFightSummary("— Fight summary —");
      }
      flushedFinalRef.current = true;
    }
    if (end !== entries.length) {
      flushedFinalRef.current = false;
    }
  }, [time, entries]);

  // popup viewer (round headers + per-round per-source lines)
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

    entries.forEach((e) => {
      if (e.type === "dsl-message") {
        const line = e.message ?? "";
        t2.writeln(line === "" ? " " : line);
      } else if (e.type === "damage" && e.payload) {
        const p = e.payload;
        t2.writeln(`⮞ Damage Round: total=${p.totalDamage}, hits=${p.hits}, misses=${p.misses}`);
        const lines = buildRoundPerSourceLines(p);
        if (lines.length) {
          t2.writeln("By source:");
          lines.forEach(l => t2.writeln(`  ${l}`));
        }
        t2.writeln("");
        t2.writeln("");
      }
    });
  };

  // copy as BBCode (round headers + per-round lines)
  const copyAsBBCode = () => {
    if (!entries.length) return;
    const parts: string[] = [];
    for (const e of entries) {
      if (e.type === "dsl-message") {
        parts.push(ansiToBBCode(e.message ?? ""));
      } else if (e.type === "damage" && e.payload) {
        const p = e.payload;
        parts.push(`[B]Damage Round:[/B] total=${p.totalDamage}, hits=${p.hits}, misses=${p.misses}`);
        const lines = buildRoundPerSourceLines(p);
        if (lines.length) {
          parts.push("[B]By source:[/B]");
          lines.forEach(l => parts.push(`  ${l}`));
        }
        parts.push("");
        parts.push("");
      }
    }
    navigator.clipboard.writeText(parts.join("\n"));
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: 8, background: "#222", color: "#fff" }}>
        <input type="file" accept=".log,.txt" onChange={onFile} />
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
              {new Date(time * 1000).toISOString().substr(11, 8)} /{" "}
              {new Date(duration * 1000).toISOString().substr(11, 8)}
            </span>
          </>
        )}
      </div>
      <div ref={termContainer} style={{ flex: 1, width: "100%", height: "100%", background: "#000" }} />
    </div>
  );
};

export default LogPlaybackXterm;
