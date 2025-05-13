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