// src/components/LogPlaybackXterm.tsx
import React, { useState, useEffect, useRef, ChangeEvent, FC } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface LogEntry {
  ts: Date;
  message: string;
}

const tickTimer = 42;

// ────────────────────────────────────────────────────────────────
// 1. parseLog – deduplicate with a proper template-literal key
// Parses JSON‑lines, keeps only type==="dsl-message"
// ────────────────────────────────────────────────────────────────
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
    if (obj.type !== "dsl-message") continue;
    raw.push({ ts: new Date(obj.timestamp), message: obj.payload });
  }

  raw.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  // de-dupe (template-literal instead of accidental string concat)
  const seen = new Set<string>();
  return raw.filter((e) => {
    const key = `${e.ts.toISOString()}|${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ────────────────────────────────────────────────────────────────
// 2. ansiToBBCode – converts ANSI SGR to nested-correct BBCode
// ────────────────────────────────────────────────────────────────
const ansiColorNames: Record<number, string> = {
  30: "BLACK",   31: "RED",        32: "GREEN",      33: "YELLOW",
  34: "BLUE",    35: "MAGENTA",    36: "CYAN",       37: "WHITE",
  90: "BROWN",   91: "ORANGE",     92: "LIME GREEN", 93: "YELLOW",
  94: "BLUE",    95: "MAGENTA",    96: "CYAN",       97: "WHITE",
};

/**
 * Convert a single line with ANSI escapes into nested-correct BBCode.
 * Closes any existing [COLOR] before opening a new one, and handles reset (0).
 */
function ansiToBBCode(line: string): string {
  const esc = /\x1b\[([0-9;]+)m/g;      // SGR escape
  let out   = "";
  let last  = 0;
  let open: string | null = null;       // currently open BBCode colour name

  // decide which foreground colour a code sequence implies
  const pick = (codes: number[]): number | undefined => {
    // explicit bright codes 90-97 win
    const bright = codes.find(c => 90 <= c && c <= 97);
    if (bright !== undefined) return bright;

    // otherwise just keep the basic 30-37 colour, even if '1' (bold) is present
    return codes.find(c => 30 <= c && c <= 37);
  };

  let m: RegExpExecArray | null;
  while ((m = esc.exec(line))) {
    out += line.slice(last, m.index);   // text before this escape
    const codes = m[1].split(";").map(Number);

    // reset closes any open tag
    if (codes.includes(0) && open) {
      out += "[/COLOR]";
      open = null;
    }

    const col = pick(codes);
    if (col !== undefined) {
      const name = ansiColorNames[col];
      if (name) {
        const nextChar = line.charAt(esc.lastIndex);   // first printable char after the escape

        /*-----------------------------------------------------------
          Web Wiz quirk: opening a tag immediately before ']' breaks
          the parser.  When that happens we simply *skip* the colour
          change and leave the current tag (if any) in place.
        -----------------------------------------------------------*/
        if (nextChar !== "]") {
          if (open) out += "[/COLOR]"; // close previous before switch
          out += `[COLOR=${name}]`;
          open = name;
        }
        // else: skip the tag entirely
      }
    }

    last = esc.lastIndex;
  }

  // tail after last escape
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

  // file load
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setEntries(parseLog(reader.result as string));
    reader.readAsText(file);
  };

  /** Copy the whole log as plain text (no colour codes) */
  const copyPlainText = () => {
    if (!entries.length) return;
    const ansi = /\x1b\[[0-9;]*[A-Za-z]/g;     // remove any ESC[…letter
    const txt = entries.map(e => e.message.replace(ansi, "")).join("\n");
    navigator.clipboard.writeText(txt);
  };

  // init xterm
  useEffect(() => {
    term.current = new Terminal({ convertEol: true });
    fit.current = new FitAddon();
    term.current.loadAddon(fit.current);
    if (termContainer.current) {
      term.current.open(termContainer.current);
      fit.current.fit();
      term.current.writeln("⮞ Ready to load .log…");
    }
    const onResize = () => fit.current?.fit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      term.current?.dispose();
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

  // render log lines
  useEffect(() => {
    if (!entries.length) return;
    const base = entries[0].ts.getTime();
    const cutoff = base + time * 1000;
    const nextIdx = entries.findIndex((e) => e.ts.getTime() > cutoff);
    const end = nextIdx === -1 ? entries.length : nextIdx;
    for (let i = lastIndexRef.current; i < end; i++) {
      term.current?.writeln(entries[i].message);
    }
    lastIndexRef.current = end;
  }, [time, entries]);

  // show whole log in popup
  const showWholeLog = () => {
    if (!entries.length) return;
    const w = window.open("", "_blank", "width=800,height=600,scrollbars=yes,resizable=yes");
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
    f2.fit();
    w.addEventListener("resize", () => f2.fit());
    entries.forEach((e) => t2.writeln(e.message));
  };

  // copy raw log as BBCode
  const copyAsBBCode = () => {
    if (!entries.length) return;
    const bb = entries.map((e) => ansiToBBCode(e.message)).join("\n");
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
