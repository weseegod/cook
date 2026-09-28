# Agent comparison: spark25-4b

Wire model: `spark25`
Thinking: `false`
Parallel: `false`

Task:

> Medium: Build a polished responsive to-do app as index.html, style.css, and app.js using only vanilla JavaScript. Support adding tasks by button or Enter, editing, completion toggle, deletion, All/Active/Completed filters, a clear-completed action, and localStorage persistence. Include useful empty states, accessible labels and keyboard focus styles. No external dependencies.

| Agent | Wall s | Exit | Model calls | Tool calls | Uncached input | Output | Cache read | Cache write | Cache field | Files | Bytes | Output tokens/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cook | 93.86 | 0 | 6 | 5 | 15273 | 7572 | 94339 | 0 | present | 3 | 21751 | 80.67 |
| opencode | 149.94 | 0 | 13 | 16 | 17326 | 11967 | 243670 | 0 | present | 3 | 26648 | 79.81 |
| pi | 283.66 | 0 | 7 | 10 | 9339 | 25014 | 115083 | 0 | present | 3 | 23754 | 88.18 |

Metrics come from each agent's JSON output. `unreported` means the field was absent.
Files and bytes count git-visible regular files in each workdir.

## Outputs

- **cook**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/cook/workdir/app.js`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/cook/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/cook/workdir/style.css`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/cook/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/cook/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/cook/stderr.log`.
- **opencode**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/opencode/workdir/app.js`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/opencode/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/opencode/workdir/style.css`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/opencode/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/opencode/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/opencode/stderr.log`.
- **pi**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/pi/workdir/app.js`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/pi/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/pi/workdir/style.css`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/pi/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/pi/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260927T060629Z/pi/stderr.log`.
