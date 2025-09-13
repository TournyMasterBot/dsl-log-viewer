// src/components/LogPlaybackXterm.tsx
import React, { useState, useEffect, useRef, ChangeEvent, FC } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface DamageActorRow {
  actor: string;
  totalAsSource: number;
  totalAsTarget: number;
  countAsSource: number;
  countAsTarget: number;
}

interface DamagePayload {
  totalDamage: number;
  hits: number;
  misses: number;
  events?: Array<{
    raw: string;
    source: string;
    target: string;
    verbKey: string;
    amount: number;
  }>;
  bySource?: DamageActorRow[];
  byTarget?: DamageActorRow[];
}

type EntryType = "dsl-message" | "damage";

interface LogEntry {
  ts: Date;
  type: EntryType;
  message?: string;        // for dsl-message
  payload?: DamagePayload; // for damage
}

const tickTimer = 42;
const FIVE_MIN_MS = 5 * 60 * 1000;

/* ────────────────────────────────────────────────────────────────
   Fit guards: only call fit() when opened + measurable + visible
   ──────────────────────────────────────────────────────────────── */
function safeFit(addon: FitAddon | null, t: Terminal | null, container: HTMLElement | null) {
  if (!addon || !t || !container) return;
  if (!t.element) return; // not opened yet
  if (!container.isConnected) return;
  const { clientWidth, clientHeight } = container;
  if (clientWidth <= 0 || clientHeight <= 0) return;
  try {
    addon.fit();
  } catch {
    /* swallow */
  }
}

/* ────────────────────────────────────────────────────────────────
   parseLog – parse JSON-lines, keep dsl-message + damage
   ──────────────────────────────────────────────────────────────── */
function parseLog(text: string): LogEntry[] {
  const raw: LogEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.type === "dsl-message") {
      raw.push({
        ts: new Date(obj.timestamp),
        type: "dsl-message",
        message: obj.payload ?? "",
      });
    } else if (obj.type === "damage") {
      raw.push({
        ts: new Date(obj.timestamp),
        type: "damage",
        payload: obj.payload as DamagePayload,
      });
    }
  }

  raw.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  // De-dupe by timestamp + type + stable content
  const seen = new Set<string>();
  return raw.filter((e) => {
    const key =
      e.type === "dsl-message"
        ? `${e.ts.toISOString()}|${e.type}|${e.message}`
        : `${e.ts.toISOString()}|${e.type}|${e.payload?.totalDamage}|${e.payload?.hits}|${e.payload?.misses}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ────────────────────────────────────────────────────────────────
   ansiToBBCode – converts ANSI SGR to nested-correct BBCode
   ──────────────────────────────────────────────────────────────── */
const ansiColorNames: Record<number, string> = {
  30: "BLACK",
  31: "RED",
  32: "GREEN",
  33: "YELLOW",
  34: "BLUE",
  35: "MAGENTA",
  36: "CYAN",
  37: "WHITE",
  90: "BROWN",
  91: "ORANGE",
  92: "LIME GREEN",
  93: "YELLOW",
  94: "BLUE",
  95: "MAGENTA",
  96: "CYAN",
  97: "WHITE",
  38: "PURPLE",
};

function ansiToBBCode(line: string): string {
  const esc = /\x1b\[([0-9;]+)m/g;
  let out = "";
  let last = 0;
  let open: string | null = null;

  const pick = (codes: number[]): number | string | undefined => {
    const bright = codes.find((c) => 90 <= c && c <= 97);
    if (bright !== undefined) return bright;

    const basic = codes.find((c) => 30 <= c && c <= 37);
    if (basic !== undefined) return basic;

    const i = codes.findIndex((c, idx) => c === 38 && codes[idx + 1] === 5);
    if (i !== -1) {
      const xterm = codes[i + 2];
      if (xterm === 61) return "PURPLE";
      return `XTERM-${xterm}`;
    }

    return undefined;
  };

  let m: RegExpExecArray | null;
  while ((m = esc.exec(line))) {
    out += line.slice(last, m.index);
    const codes = m[1].split(";").map(Number);

    if (codes.includes(0) && open) {
      out += "[/COLOR]";
      open = null;
    }

    const col = pick(codes);
    if (col !== undefined) {
      const name = typeof col === "number" ? ansiColorNames[col] : col;
      if (name) {
        const nextChar = line.charAt(esc.lastIndex);
        if (nextChar !== "]") {
          if (open) out += "[/COLOR]";
          out += `[COLOR=${name}]`;
          open = name;
        }
      }
    }

    last = esc.lastIndex;
  }

  out += line.slice(last);
  if (open) out += "[/COLOR]";
  return out;
}

const LogPlaybackXterm: FC = () => {
  // state hooks
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

  // batching for damage
  const lastDamageTsRef = useRef<number | null>(null);
  const batchTotalsRef = useRef<Map<string, { total: number; count: number }>>(new Map());
  const flushedFinalRef = useRef<boolean>(false);

  // file load
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setEntries(parseLog(reader.result as string));
    reader.readAsText(file);
  };

  /** Copy: plain text (round summaries only) */
  const copyPlainText = () => {
    if (!entries.length) return;
    const ansi = /\x1b\[[0-9;]*[A-Za-z]/g;
    const txt = entries
      .map((e) => {
        if (e.type === "dsl-message") return (e.message ?? "").replace(ansi, "");
        if (e.type === "damage" && e.payload) {
          const p = e.payload;
          return `Damage Round: total=${p.totalDamage}, hits=${p.hits}, misses=${p.misses}`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    navigator.clipboard.writeText(txt);
  };

  // init xterm (robust fit)
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

      const io = new IntersectionObserver(
        (entries) => {
          for (const en of entries) if (en.isIntersecting) safeFit(fit.current, term.current, container);
        },
        { threshold: 0.01 }
      );
      io.observe(container);

      const onResize = () => safeFit(fit.current, term.current, container);
      window.addEventListener("resize", onResize);

      return () => {
        window.removeEventListener("resize", onResize);
        io.disconnect();
        ro.disconnect();
        term.current?.dispose();
        term.current = null;
        fit.current = null;
      };
    }

    return () => {
      term.current?.dispose();
      term.current = null;
      fit.current = null;
    };
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

    // reset batch state
    lastDamageTsRef.current = null;
    batchTotalsRef.current.clear();
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

  // helpers for batching
  const addToBatch = (rows?: DamageActorRow[]) => {
    if (!rows || !rows.length) return;
    const map = batchTotalsRef.current;
    for (const r of rows) {
      const cur = map.get(r.actor) ?? { total: 0, count: 0 };
      cur.total += r.totalAsSource || 0;
      cur.count += r.countAsSource || 0;
      map.set(r.actor, cur);
    }
  };

  const flushBatchTotals = (label: string) => {
    const map = batchTotalsRef.current;
    if (map.size === 0) return;
    term.current?.writeln(label);
    const rows = [...map.entries()].sort((a, b) => b[1].total - a[1].total);
    for (const [actor, agg] of rows) {
      term.current?.writeln(
        `  - ${actor} → total ${Number(agg.total.toFixed(1))} dmg in ${agg.count} hits`
      );
    }
    term.current?.writeln(""); // spacer
    map.clear();
  };

  // render log lines with batching (NO per-event bullets)
  useEffect(() => {
    if (!entries.length) return;
    const base = entries[0].ts.getTime();
    const cutoff = base + time * 1000;
    const nextIdx = entries.findIndex((e) => e.ts.getTime() > cutoff);
    const end = nextIdx === -1 ? entries.length : nextIdx;

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

        // 5+ minute gap between damage rounds => flush batch
        if (
          lastDamageTsRef.current !== null &&
          curTs - lastDamageTsRef.current >= FIVE_MIN_MS
        ) {
          flushBatchTotals("— Running totals by source (batch ended: 5+ min gap) —");
        }

        // Round header only
        term.current?.writeln(
          `⮞ Damage Round: total=${p.totalDamage}, hits=${p.hits}, misses=${p.misses}`
        );

        // Accumulate totals by source
        addToBatch(p.bySource);

        // Track last damage ts
        lastDamageTsRef.current = curTs;

        // Two blank lines after round
        term.current?.writeln("");
        term.current?.writeln("");
      }
    }

    lastIndexRef.current = end;

    // End-of-log flush
    if (end === entries.length && !flushedFinalRef.current) {
      flushBatchTotals("— Final totals by source —");
      flushedFinalRef.current = true;
    }
    if (end !== entries.length) {
      flushedFinalRef.current = false;
    }
  }, [time, entries]);

  // popup (NO per-event bullets — mirrors terminal)
  const showWholeLog = () => {
    if (!entries.length) return;
    const w = window.open(
      "",
      "_blank",
      "width=800,height=600,scrollbars=yes,resizable=yes"
    );
    if (!w) return;

    document
      .querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')
      .forEach((n) => w.document.head.appendChild(n.cloneNode(true)));
    Object.assign(w.document.body.style, { margin: "0", background: "#000" });

    const container = w.document.createElement("div");
    Object.assign(container.style, { width: "100%", height: "100vh" });
    w.document.body.appendChild(container);

    const t2 = new Terminal({ convertEol: true } as any);
    const f2 = new FitAddon();
    t2.loadAddon(f2);
    t2.open(container);

    const fitPopup = () => {
      try {
        if (container.isConnected && container.clientWidth > 0 && container.clientHeight > 0) {
          f2.fit();
        }
      } catch {}
    };
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
        t2.writeln("");
        t2.writeln("");
      }
    });
  };

  // copy as BBCode (round summaries only)
  const copyAsBBCode = () => {
    if (!entries.length) return;
    const bb = entries
      .map((e) => {
        if (e.type === "dsl-message") return ansiToBBCode(e.message ?? "");
        if (e.type === "damage" && e.payload) {
          const p = e.payload;
          return `[B]Damage Round:[/B] total=${p.totalDamage}, hits=${p.hits}, misses=${p.misses}`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    navigator.clipboard.writeText(bb);
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
      <div
        ref={termContainer}
        style={{ flex: 1, width: "100%", height: "100%", background: "#000" }}
      />
    </div>
  );
};

export default LogPlaybackXterm;
