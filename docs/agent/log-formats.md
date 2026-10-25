---
id: log-viewer-formats
title: DslLogViewer log formats, how each tab reads them, and how the exports are built
kind: protocol
tags: [dsl, log-viewer, jsonl, playback, bbcode, ansi, export, blank-lines, clean-log, game-server]
repo: DslLogViewer
paths: [dsl-log-viewer/src/components/LogPlayback.tsx, dsl-log-viewer/src/components/LogPasteViewer.tsx, dsl-log-viewer/src/damageParser.ts, dsl-log-viewer/scripts/build-clean-jsonl.mjs]
verified_date: 2026-10-15
verified_commit: 286f6aa+working-tree
status: current
---

# DslLogViewer: formats and exports

`README.md` at the repo root documents only the legacy `dsl-message` record. The game server now writes the shapes below; the viewer reads both.

## Two tabs, two parsers

- **JSONL Playback** (`LogPlayback.tsx`, `parseLog`) reads jsonl only. Timed playback, the terminal view, and the Copy/Download buttons for BBCode, HTML and plain text.
- **Paste / Text Log** (`LogPasteViewer.tsx`) reads TEXT: raw logs with `¤TS=` prefixes, Mudlet, timestamped plain text, or plain text with ANSI. Its file picker accepts `.jsonl` but there is no JSON parsing: a jsonl loaded there is shown as lines of JSON. Use JSONL Playback for jsonl.

## Records JSONL Playback understands

One JSON object per line; entries are sorted by `timestamp` (stable) after parsing.

| `type` | `payload` | Becomes |
|---|---|---|
| `game:remote-server:raw` | `{"type":"raw","data":"<text with ANSI>"}` | a text entry; records with an empty `data` are skipped |
| `game:client:input` | a JSON STRING: `"{\"type\":\"data\",\"data\":\"nod aoth\"}"` | a dim `> nod aoth` line |
| `game:remote-server:gmcp` | `{"type":"gmcp","data":"char_data {...}"}` | ignored |
| `dsl-message` (legacy) | the text itself | a text entry, de-duplicated on timestamp+text |
| `damage` (legacy) | structured round data | round summaries |

In a real game log almost every `raw` record is ONE line ending in `\r\n`; a record that is only `\r\n` is a blank line from the game, and the prompt line (`<1645/1645hp ... [11:00am]>`) is its own record.

## The terminal view and the exports treat blank lines differently

- The **terminal view** writes each record's `data` as it is (xterm, `convertEol`). A blank line appears only where the data holds one.
- The **text / BBCode / HTML exports** (`collectAnsiLines`) split each record into lines with `recordLines()`. A trailing newline ends the last line and does not start an empty one. Before `recordLines()` existed the exports split on `\r?\n` alone, so EVERY record got an extra blank line after it and a raw log exported double-spaced (the room-description lines were separated by blank lines).
- A file that holds literal blank lines in its record data therefore looks the same in the terminal and in the exports only on a build that has `recordLines()`. `scripts/build-clean-jsonl.mjs --legacy-export` writes the shape older builds need.

## Exports add summaries unless told not to

`collectAnsiLines` appends damage annotations, "─── Round ───" blocks and a "— Fight summary —" block for combat lines. They are on by default. Tick **Skip damage summaries** (`skipAll`) before exporting when the output must equal the source text line for line.

## BBCode

`ansiToBBCode` converts one line at a time and closes its colour tag at the end of the line, so colour state does NOT carry across lines. Each exported line must carry its own colour codes. The game sometimes leaves a colour open over several lines; `build-clean-jsonl.mjs` prefixes the open colour onto a kept line only when visible text comes before that line's own first colour code. 30-37 and 90-97 map to names, `38;5;61` to PURPLE, other 256-colour codes to `XTERM-n`.

## Building a clean jsonl from a hand-cleaned text

`pnpm clean-jsonl "<raw>.jsonl" "<clean>.txt" ["<out>.jsonl"] [--legacy-export]` from `dsl-log-viewer/`.

- Every non-blank line of the clean text must exist in the raw log (the colours come from there); the script stops and lists the ones that do not (a hand-edited line cannot be coloured).
- It aligns with an LCS, not a greedy match: the clean text can drop, repeat and reorder lines relative to the raw log, and a greedy in-order match fails at the first of them.
- A BEL (`\x07`, sent before some tells) is removed, as in the clean text.
- It replays the viewer's text export (and the terminal view) over its own output and exits 1 unless the result equals the clean text.
