# Agent comparison: stealth/space-bunny-alpha

Wire model: `stealth/space-bunny-alpha`
Thinking: `true`
Parallel: `false`

Task:

> Medium: Build a polished responsive to-do app as index.html, style.css, and app.js using only vanilla JavaScript. Support adding tasks by button or Enter, editing, completion toggle, deletion, All/Active/Completed filters, a clear-completed action, and localStorage persistence. Include useful empty states, accessible labels and keyboard focus styles. No external dependencies.

| Agent | Wall s | Exit | Model calls | Tool calls | Uncached input | Output | Cache read | Cache write | Cache field | Files | Bytes | Output tokens/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cook | 169.28 | 0 | 43 | 42 | 18488 | 12854 | 1092279 | 0 | present | 3 | 17517 | 75.93 |
| opencode | 207.73 | 0 | 42 | 42 | 14257 | 16327 | 863626 | 0 | present | 3 | 22830 | 78.6 |
| pi | 38.46 | 0 | 5 | 6 | 1737 | 5874 | 21665 | 0 | present | 3 | 18758 | 152.73 |

Metrics come from each agent's JSON output. `unreported` means the field was absent.
Files and bytes count git-visible regular files in each workdir.

## Outputs

- **cook**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/cook/workdir/app.js`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/cook/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/cook/workdir/style.css`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/cook/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/cook/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/cook/stderr.log`.
- **opencode**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/opencode/workdir/app.js`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/opencode/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/opencode/workdir/style.css`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/opencode/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/opencode/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/opencode/stderr.log`.
- **pi**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/pi/workdir/app.js`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/pi/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/pi/workdir/style.css`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/pi/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/pi/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004858Z/pi/stderr.log`.
