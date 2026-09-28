# Agent comparison: stealth/space-bunny-alpha

Wire model: `stealth/space-bunny-alpha`
Thinking: `true`
Parallel: `false`

Task:

> Hard: Build a polished responsive Kanban project board as index.html, style.css, and app.js using vanilla JavaScript only. Start with Backlog, In Progress, and Done columns. Support creating, editing, and deleting cards with title, description, priority, and due date; searching by text; filtering by priority; and moving cards between columns by drag and drop. Provide keyboard-accessible move controls as an alternative to dragging, visible focus styles, empty states, and per-column task counts. Save and restore all board data in localStorage, handle invalid stored data safely, and make the layout usable on a phone. No external dependencies.

| Agent | Wall s | Exit | Model calls | Tool calls | Uncached input | Output | Cache read | Cache write | Cache field | Files | Bytes | Output tokens/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cook | 168.00 | 0 | 27 | 26 | 15107 | 15860 | 684584 | 0 | present | 3 | 29696 | 94.41 |
| opencode | 814.19 | 0 | 138 | 138 | 61942 | 64067 | 7982825 | 0 | present | 3 | 59490 | 78.69 |
| pi | 244.29 | 0 | 30 | 29 | 14921 | 24396 | 587792 | 0 | present | 3 | 37685 | 99.86 |

Metrics come from each agent's JSON output. `unreported` means the field was absent.
Files and bytes count git-visible regular files in each workdir.

## Outputs

- **cook**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/cook/workdir/app.js`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/cook/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/cook/workdir/style.css`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/cook/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/cook/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/cook/stderr.log`.
- **opencode**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/opencode/workdir/app.js`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/opencode/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/opencode/workdir/style.css`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/opencode/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/opencode/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/opencode/stderr.log`.
- **pi**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/pi/workdir/app.js`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/pi/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/pi/workdir/style.css`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/pi/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/pi/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T011045Z/pi/stderr.log`.
