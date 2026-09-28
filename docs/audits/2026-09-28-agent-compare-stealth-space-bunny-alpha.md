# Agent comparison: stealth/space-bunny-alpha

Wire model: `stealth/space-bunny-alpha`
Thinking: `true`
Parallel: `false`

Task:

> Hard: Build a polished, fully playable Minesweeper as index.html, style.css, and app.js using vanilla JavaScript only. Provide beginner/intermediate/expert boards, safe first reveal, correct flood-fill for empty cells, right-click flag/unflag, a mobile-friendly flag mode, mine counter, timer, win/loss states, restart, and best times saved in localStorage. Make every control keyboard-accessible and keep the layout usable on a phone. No external dependencies.

| Agent | Wall s | Exit | Model calls | Tool calls | Uncached input | Output | Cache read | Cache write | Cache field | Files | Bytes | Output tokens/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cook | 460.74 | 1 | unreported | unreported | unreported | unreported | unreported | unreported | unreported | 0 | 0 | unreported |
| opencode | 306.45 | 0 | 54 | 54 | 14142 | 31699 | 1569236 | 0 | present | 4 | 50633 | 103.44 |
| pi | 93.59 | 0 | 2 | 1 | 1755 | 8239 | 1961 | 0 | present | 0 | 0 | 88.04 |

Metrics come from each agent's JSON output. `unreported` means the field was absent.
Files and bytes count git-visible regular files in each workdir.

## Outputs

- **cook**: files none; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T005604Z/cook/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T005604Z/cook/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T005604Z/cook/stderr.log`.
- **opencode**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T005604Z/opencode/workdir/app.js`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T005604Z/opencode/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T005604Z/opencode/workdir/style.css`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T005604Z/opencode/workdir/test.headless.js`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T005604Z/opencode/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T005604Z/opencode/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T005604Z/opencode/stderr.log`.
- **pi**: files none; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T005604Z/pi/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T005604Z/pi/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T005604Z/pi/stderr.log`.
