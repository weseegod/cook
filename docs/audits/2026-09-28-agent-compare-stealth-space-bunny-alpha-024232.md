# Agent comparison: stealth/space-bunny-alpha

Wire model: `stealth/space-bunny-alpha`
Thinking: `true`
Parallel: `false`

Task:

> Hard: Build a polished responsive personal finance dashboard as index.html, style.css, and app.js using vanilla JavaScript only. Support income and expense transactions with amount, date, category, and note; create, edit, and delete transactions; and filter/search by month, type, and category. Show monthly income, expenses, and net balance, plus a category spending breakdown and a six-month trend chart rendered with inline SVG or CSS. Let users set monthly spending budgets by category and show progress with clear over-budget states. Include useful empty states, accessible forms and labels, keyboard focus styles, sensible currency/date formatting, and localStorage persistence with safe recovery from invalid stored data. Make the layout usable on a phone. No external dependencies.

| Agent | Wall s | Exit | Model calls | Tool calls | Uncached input | Output | Cache read | Cache write | Cache field | Files | Bytes | Output tokens/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cook | 1287.97 | 1 | 80 | 81 | 56473 | 52540 | 3641362 | 0 | present | 3 | 49962 | 40.79 |
| opencode | 399.45 | 0 | 39 | 39 | 42287 | 32383 | 1178556 | 0 | present | 3 | 53848 | 81.07 |
| pi | 591.34 | 0 | 65 | 64 | 53739 | 76043 | 4992086 | 0 | present | 3 | 87303 | 128.59 |

Metrics come from each agent's JSON output. `unreported` means the field was absent.
Files and bytes count git-visible regular files in each workdir.

## Outputs

- **cook**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/cook/workdir/app.js`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/cook/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/cook/workdir/style.css`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/cook/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/cook/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/cook/stderr.log`.
- **opencode**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/opencode/workdir/app.js`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/opencode/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/opencode/workdir/style.css`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/opencode/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/opencode/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/opencode/stderr.log`.
- **pi**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/pi/workdir/app.js`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/pi/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/pi/workdir/style.css`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/pi/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/pi/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T020433Z/pi/stderr.log`.
