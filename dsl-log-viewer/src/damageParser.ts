// Damage parsing utilities for DslLogViewer
// Values ported from apps/game-client/src/features/combat/damage/damage-map.ts

export const DAMAGE_VALUES: Record<string, number> = {
  // Greens
  misses: 0,      miss: 0,
  scratches: 2.5, scratch: 2.5,
  grazes: 6.5,    graze: 6.5,
  hits: 10.5,     hit: 10.5,
  injures: 14.5,  injure: 14.5,
  wounds: 18.5,   wound: 18.5,
  mauls: 22.5,    maul: 22.5,
  decimates: 26.5, decimate: 26.5,
  devastates: 30.5, devastate: 30.5,
  maims: 34.5,    maim: 34.5,
  // Yellows
  MUTILATES: 38.5, MUTILATE: 38.5,
  DISEMBOWELS: 42.5, DISEMBOWEL: 42.5,
  DISMEMBERS: 46.5, DISMEMBER: 46.5,
  MASSACRES: 50.5, MASSACRE: 50.5,
  MANGLES: 54.5,  MANGLE: 54.5,
  // Reds
  DEMOLISHES: 58.5, DEMOLISH: 58.5,
  DEVASTATES: 68,  DEVASTATE: 68,
  OBLITERATES: 88, OBLITERATE: 88,
  ANNIHILATES: 113, ANNIHILATE: 113,
  ERADICATES: 138, ERADICATE: 138,
  // Blinks
  GHASTLY: 163,
  HORRID: 188,
  DREADFUL: 213,
  HIDEOUS: 238,
  INDESCRIBABLE: 263,
  UNSPEAKABLE: 276,
};

// Sorted longest-first so "OBLITERATES" beats "OBLITERATE", etc.
export const DAMAGE_KEYS_SORTED = Object.keys(DAMAGE_VALUES).sort((a, b) => b.length - a.length);

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
export function stripAnsi(s: string): string { return s.replace(ANSI_RE, ''); }

export function fmt1(n: number): string {
  const v = Math.round((n ?? 0) * 10) / 10;
  return Number.isFinite(v) ? (v % 1 === 0 ? String(v) : v.toFixed(1)) : '0';
}

export interface ParsedDmg {
  key: string;
  value: number;
  /** Character index of the keyword in the stripped (no-ANSI) text. */
  plainIndex: number;
}

/**
 * Parse a damage keyword from a line that may or may not contain ANSI codes.
 * Strips ANSI first, then case-sensitively matches damage keys (longest first).
 * Returns null if no damage keyword found.
 */
export function parseDmgLine(line: string): ParsedDmg | null {
  const plain = stripAnsi(line);
  // Skip death/kill announcement lines where damage verbs appear in non-combat context
  if (/\bDEAD[.!]/.test(plain) || /\bhits the ground\b/.test(plain)) return null;
  for (const key of DAMAGE_KEYS_SORTED) {
    const idx = plain.indexOf(key);
    if (idx === -1) continue;
    // Word-boundary check (prev/next char must not be a letter)
    const pre  = idx > 0               ? plain[idx - 1]          : ' ';
    const post = idx + key.length < plain.length ? plain[idx + key.length] : ' ';
    if (/[a-zA-Z]/.test(pre) || /[a-zA-Z]/.test(post)) continue;
    return { key, value: DAMAGE_VALUES[key], plainIndex: idx };
  }
  return null;
}

// Matches "[ Room Name ] " at the start of a line
const ROOM_PREFIX_RE = /^\s*\[\s*[^\]]*\]\s*/;

/**
 * Extract the attacker name from the left side of the plain-text line.
 * Strips any room prefix ([ Room Name ]) and possessive+weapon (" 's chop").
 */
export function dmgSource(plain: string, keyIdx: number): string {
  if (keyIdx <= 0) return '?';
  const left = plain
    .slice(0, keyIdx)
    .replace(ROOM_PREFIX_RE, '')    // strip [ Room Name ]
    .trim()
    .replace(/[*>=<\-\s]+$/, '')    // strip trailing decoration
    .replace(/[,:;.\s]+$/, '')      // strip trailing punctuation
    .trim();
  if (!left) return '?';
  if (left.startsWith('Your ') || left.startsWith('You ')) return 'You';
  // "Reitrulim's shocking bite" → "Reitrulim"
  const possIdx = left.indexOf("'s ");
  if (possIdx !== -1) return left.slice(0, possIdx).trim();
  return left;
}

/**
 * Extract the target from the text AFTER the damage keyword.
 * e.g. " Reitrulim." → "Reitrulim"
 *      " <<< Pannod!" → "Pannod"
 *      " a gryffon!" → "gryffon"
 *      " things to Pannod!" → "Pannod"
 */
export function dmgTarget(textAfterKey: string): string {
  // Strip leading decoration chars (*, >, <, =, !) and whitespace
  const text = textAfterKey
    .replace(/^[\s*><!=\-]+/, '')
    .replace(/[!\r\n.]+$/, '')
    .trim();
  if (!text) return '?';

  // "a X" / "an X" — target prefixed with article
  const aMatch = text.match(/^an?\s+(\S.*)/i);
  if (aMatch) return aMatch[1].replace(/[!\r\n.]+$/, '').trim();

  // "things to X" — used by HIDEOUS-tier hit messages
  const thingsTo = text.match(/^things to (.+)$/i);
  if (thingsTo) return thingsTo[1].replace(/[!\r\n.]+$/, '').trim();

  if (/^you$/i.test(text)) return 'you';

  return text;
}

// ─── Terminal color constants ─────────────────────────────────────────────────
const R       = '\x1b[0m';
const CYAN    = '\x1b[0;36m';
const BCYAN   = '\x1b[1;36m';
const YELLOW  = '\x1b[0;33m';
const GRAY    = '\x1b[2;37m';
const MAGENTA = '\x1b[0;35m';
const BLUE    = '\x1b[0;34m';

// Damage tier colors — match DamageMapAnsi from damage-map.ts
const COL_GREEN  = '\x1b[0;32m';   // miss … maim  (0 – 34.5)
const COL_YELLOW = '\x1b[1;33m';   // MUTILATES … MANGLES  (38.5 – 54.5)
const COL_RED    = '\x1b[1;31m';   // DEMOLISHES … ERADICATES  (58.5 – 138)
const COL_BLINK  = '\x1b[1;37m';   // GHASTLY … UNSPEAKABLE  (163+)

/**
 * Returns the ANSI color for a damage value based on its tier.
 * Aggregated values use the same thresholds so totals are colored consistently.
 */
export function dmgColor(value: number): string {
  if (value <= 0)    return GRAY;
  if (value <= 34.5) return COL_GREEN;
  if (value <= 54.5) return COL_YELLOW;
  if (value <= 162)  return COL_RED;
  return COL_BLINK;
}

/** Inline damage annotation appended to a damage line: blue parens, tier-colored value. */
export const dmgAnnotation = (val: number): string =>
  ` ${BLUE}(${R}${dmgColor(val)}${fmt1(val)}${BLUE})${R}`;

// ─── Event & aggregate types ──────────────────────────────────────────────────

export interface DmgEvent {
  source: string;
  target: string;
  key: string;
  value: number; // 0 = miss
}

export interface TargetAgg {
  damage: number;
  hits: number;
  misses: number;
}

export interface ActorAgg {
  damage: number;
  hits: number;
  misses: number;
  targets: Map<string, TargetAgg>;
}

function newAgg(): ActorAgg {
  return { damage: 0, hits: 0, misses: 0, targets: new Map() };
}

export function eventsToActorMap(events: DmgEvent[]): Map<string, ActorAgg> {
  const map = new Map<string, ActorAgg>();
  for (const ev of events) {
    const src = ev.source || '?';
    let a = map.get(src);
    if (!a) { a = newAgg(); map.set(src, a); }
    let tgt = a.targets.get(ev.target);
    if (!tgt) { tgt = { damage: 0, hits: 0, misses: 0 }; a.targets.set(ev.target, tgt); }
    if (ev.value > 0) {
      a.damage   += ev.value;
      a.hits     += 1;
      tgt.damage += ev.value;
      tgt.hits   += 1;
    } else {
      a.misses  += 1;
      tgt.misses += 1;
    }
  }
  return map;
}

// ─── Summary line builders ─────────────────────────────────────────────────────

interface TargetGroup {
  damage: number;
  hits: number;
  misses: number;
  /** damage verb → { count, value } */
  types: Map<string, { count: number; value: number }>;
}

interface SourceGroup {
  damage: number;
  hits: number;
  misses: number;
  targets: Map<string, TargetGroup>;
}

function typeString(types: Map<string, { count: number; value: number }>): string {
  return [...types.entries()]
    .sort((a, b) => b[1].value - a[1].value || b[1].count - a[1].count)
    .map(([verb, t]) => t.count > 1 ? `${verb}×${t.count}` : verb)
    .join(', ');
}

export function buildRoundSummaryLines(events: DmgEvent[]): string[] {
  if (events.length === 0) return [];

  // Aggregate: source → target → stats
  const bySource = new Map<string, SourceGroup>();
  for (const ev of events) {
    let src = bySource.get(ev.source);
    if (!src) {
      src = { damage: 0, hits: 0, misses: 0, targets: new Map() };
      bySource.set(ev.source, src);
    }
    let tgt = src.targets.get(ev.target);
    if (!tgt) {
      tgt = { damage: 0, hits: 0, misses: 0, types: new Map() };
      src.targets.set(ev.target, tgt);
    }
    if (ev.value > 0) {
      src.damage += ev.value;  src.hits++;
      tgt.damage += ev.value;  tgt.hits++;
      const t = tgt.types.get(ev.key) ?? { count: 0, value: ev.value };
      t.count++;
      tgt.types.set(ev.key, t);
    } else {
      src.misses++;
      tgt.misses++;
    }
  }

  const roundTotal = events.reduce((s, e) => s + e.value, 0);
  const lines: string[] = [];
  lines.push(`${CYAN}─── Round ──────────────────────────────${R}`);

  for (const [srcName, src] of bySource) {
    // Source total line
    const srcRatio = `${GRAY}[${src.hits}h/${src.misses}m]${R}`;
    lines.push(
      `  ${YELLOW}${srcName}${R}: ${dmgColor(src.damage)}${fmt1(src.damage)}${R}  ${srcRatio}`
    );
    // Per-target breakdown (indented)
    for (const [tgtName, tgt] of src.targets) {
      const types = typeString(tgt.types);
      const tgtDmg = tgt.hits > 0 ? `${dmgColor(tgt.damage)}${fmt1(tgt.damage)}${R}` : `${GRAY}0${R}`;
      const tgtTypes = types ? `  ${GRAY}${types}${R}` : '';
      lines.push(
        `    ${GRAY}→${R} ${MAGENTA}${tgtName}${R}: ${tgtDmg}${tgtTypes}`
      );
    }
  }

  lines.push(`  Round total: ${dmgColor(roundTotal)}${fmt1(roundTotal)}${R}`);
  lines.push(`${CYAN}───────────────────────────────────────${R}`);
  return lines;
}

export function buildFightSummaryLines(allEvents: DmgEvent[]): string[] {
  if (allEvents.length === 0) return [];
  const lines: string[] = [];
  const actorMap = eventsToActorMap(allEvents);
  const totalDmg    = [...actorMap.values()].reduce((s, a) => s + a.damage, 0);
  const totalHits   = [...actorMap.values()].reduce((s, a) => s + a.hits, 0);
  const totalMisses = [...actorMap.values()].reduce((s, a) => s + a.misses, 0);

  lines.push(`${BCYAN}══════════ FIGHT SUMMARY ══════════════${R}`);
  const sorted = [...actorMap.entries()].sort((a, b) => b[1].damage - a[1].damage);
  for (const [actor, agg] of sorted) {
    lines.push(
      `  ${YELLOW}${actor}${R}: ${dmgColor(agg.damage)}${fmt1(agg.damage)}${R} dmg` +
      `  ${GRAY}·${R}  ${agg.hits} hits  ${GRAY}·${R}  ${agg.misses} misses`
    );
    const tgtsSorted = [...agg.targets.entries()].sort((a, b) => b[1].damage - a[1].damage);
    for (const [tgt, t] of tgtsSorted) {
      lines.push(
        `    ${GRAY}→${R} ${MAGENTA}${tgt}${R}: ${dmgColor(t.damage)}${fmt1(t.damage)}${R}` +
        `  ${GRAY}[${t.hits}h/${t.misses}m]${R}`
      );
    }
  }
  lines.push(`  ${GRAY}─────────────────────────────────────${R}`);
  lines.push(
    `  Total: ${dmgColor(totalDmg)}${fmt1(totalDmg)}${R} dmg` +
    `  ${GRAY}·${R}  ${totalHits} hits  ${GRAY}·${R}  ${totalMisses} misses`
  );
  lines.push(`${BCYAN}═══════════════════════════════════════${R}`);
  return lines;
}

// ─── ANSI → HTML conversion ───────────────────────────────────────────────────

// [normal, bold/bright] CSS color values for a dark-background terminal palette
const ANSI_FG_CSS: Record<number, [string, string]> = {
  30: ["#555555", "#555555"],
  31: ["#cc0000", "#ff5555"],
  32: ["#00aa00", "#55ff55"],
  33: ["#aa5500", "#ffff55"],
  34: ["#0000cc", "#5555ff"],
  35: ["#aa00aa", "#ff55ff"],
  36: ["#00aaaa", "#55ffff"],
  37: ["#aaaaaa", "#ffffff"],
};

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Converts ANSI SGR color codes in a line to HTML <span> elements with inline styles.
 * Handles: reset (0), bold (1), dim (2), fg (30-37), bright fg (90-97).
 * All text content is HTML-escaped.
 */
export function ansiToHtml(line: string): string {
  const esc = /\x1b\[([0-9;]*)m/g;
  let out = "";
  let last = 0;
  let spanOpen = false;

  let m: RegExpExecArray | null;
  while ((m = esc.exec(line))) {
    out += escHtml(line.slice(last, m.index));
    last = esc.lastIndex;
    const codes = m[1] ? m[1].split(";").map(Number) : [0];

    if (codes.includes(0) && spanOpen) { out += "</span>"; spanOpen = false; }

    const bold      = codes.includes(1);
    const dim       = codes.includes(2);
    const bright90  = codes.find(c => c >= 90 && c <= 97);
    const fg30      = codes.find(c => c >= 30 && c <= 37);

    let color: string | null = null;
    if (bright90 !== undefined) {
      color = ANSI_FG_CSS[bright90 - 60]?.[1] ?? null;
    } else if (fg30 !== undefined) {
      color = (dim && fg30 === 37) ? "#777777" : (ANSI_FG_CSS[fg30]?.[bold ? 1 : 0] ?? null);
    }

    if (color) {
      if (spanOpen) out += "</span>";
      out += `<span style="color:${color}">`;
      spanOpen = true;
    }
  }

  out += escHtml(line.slice(last));
  if (spanOpen) out += "</span>";
  return out;
}

/**
 * Wraps HTML lines in a dark-background <pre> block suitable for embedding or downloading.
 */
export function buildHtmlPage(htmlLines: string[]): string {
  const body = htmlLines.join("\n");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{background:#111;color:#ccc;margin:0;padding:8px}
pre{font-family:'Courier New',Courier,monospace;font-size:13px;line-height:1.4;white-space:pre-wrap;word-break:break-all}
</style></head><body><pre>${body}</pre></body></html>`;
}

/**
 * Annotates raw server data (may contain multiple \n-separated lines and ANSI codes).
 * Appends damage annotation after lines that contain a damage keyword, before the newline.
 */
export function annotateRawData(data: string): string {
  if (!data) return data;
  const out: string[] = [];
  let pos = 0;
  while (pos < data.length) {
    const nl  = data.indexOf('\n', pos);
    const end = nl === -1 ? data.length : nl + 1;
    const line = data.slice(pos, end);
    // Strip trailing \r\n to determine content, then re-attach suffix
    const content = line.replace(/[\r\n]+$/, '');
    const suffix  = line.slice(content.length);
    const dmg = parseDmgLine(content);
    if (dmg) {
      out.push(content + dmgAnnotation(dmg.value) + suffix);
    } else {
      out.push(line);
    }
    pos = end;
    if (nl === -1) break;
  }
  return out.join('');
}
