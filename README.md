# Setup
* Clone the project
* `cd dsl-log-viewer`
* `npm install`
* `npm run dev`
* Select a log file, hit `start` and enjoy!

# Log format

```
(Main client message)
{"type":"dsl-message","timestamp":"2025-05-13 11:26:58.831","subtype":"raw-buffer","payload":"\u001b[0m[ IMPLEMENTOR ] \u001b[0;31m[ \u001b[1;30mChaos \u001b[0;31m]\u001b[0m Scorn. \u001b[0m"}

GMCP (Currently Ignored)
{"type":"gmcp","timestamp":"2025-05-13 11:26:58.834","subtype":"char_data","payload":{"hp":1471,"max_hp":1471,"mana":769,"max_mana":769,"move":406,"max_move":406,"gold":1744,"silver":17,"wimpy":0,"str":62,"max_str":62,"int":60,"max_int":60,"wis":78,"max_wis":78,"dex":73,"max_dex":73,"con":42,"max_con":42,"stance":"Offensive","language":"Common","tnl":473558,"carry_weight":337,"can_carry_weight":709,"is_afk":false,"is_quiet":false,"is_flying":true,"is_riding":false,"is_fighting":false}}
```
* type: Shattered Archive message type. Currently this log viewer only displays 'dsl-message' which is the raw game message from DSL
* subtype: Message sub type to help categorize what type of message was received over the socket
* payload: Message payload
* timestamp = ISO 8601 timestamp

> Note: Shattered Archive logs using ANSI color codes, which come directly from DSL.

# Cleaning a raw jsonl

A raw game log has prompts, GMCP and repeated text. To get a small jsonl that keeps only what a hand-cleaned plain-text copy of it keeps (colors and timestamps included):

```
cd dsl-log-viewer
pnpm clean-jsonl "<raw>.jsonl" "<clean>.txt" ["<out>.jsonl"] [--legacy-export]
```

* `<out>.jsonl` defaults to `<clean>.txt` with a `.jsonl` extension; an existing file is overwritten.
* Every non-blank line of the clean text must exist in the raw log (the colors come from there); the script stops and lists any line that does not.
* It replays the viewer over its own output (the text export and, by default, the terminal view) and exits with an error unless the result equals the clean text.
* Load the result on the **JSONL Playback** tab and tick **Skip damage summaries** before using the Copy/Download buttons.
* **Blank lines:** by default they are written as real blank lines, which needs a viewer build with `recordLines()` in `LogPlayback.tsx`. Older builds add an extra blank line after every record in the exports; for those pass `--legacy-export`, whose exports are right but whose on-screen terminal shows no blank lines between messages.
* Details of the record shape are in the header of `dsl-log-viewer/scripts/build-clean-jsonl.mjs`.