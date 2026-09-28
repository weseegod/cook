# Agent comparison: stealth/space-bunny-alpha

Wire model: `stealth/space-bunny-alpha`
Thinking: `true`
Parallel: `false`

Task:

> Hard: Build a polished, responsive monthly event calendar as index.html, style.css, and app.js using vanilla JavaScript only. Provide previous/next month and Today controls, a seven-column month grid with adjacent-month dates, and a mobile-friendly agenda view. Let users create, edit, and delete events with title, date, start/end time, category, and notes; validate required fields and time ranges. Selecting a date should offer event creation, and selecting an event should open its details for editing. Include category filters, clear empty states, keyboard navigation for calendar dates, accessible dialogs and labels, visible focus styles, and localStorage persistence with safe recovery from invalid stored data. No external dependencies.

| Agent | Wall s | Exit | Model calls | Tool calls | Uncached input | Output | Cache read | Cache write | Cache field | Files | Bytes | Output tokens/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cook | 156.39 | 1 | 4 | 4 | 22975 | 11883 | 46406 | 0 | present | 2 | 26150 | 75.98 |
| opencode | 1048.51 | 0 | 103 | 103 | 21799 | 81156 | 7352358 | 0 | present | 3 | 74951 | 77.4 |
| pi | 778.11 | 0 | 71 | 70 | 43343 | 61466 | 4168712 | 0 | present | 3 | 65420 | 78.99 |

Metrics come from each agent's JSON output. `unreported` means the field was absent.
Files and bytes count git-visible regular files in each workdir.

## Outputs

- **cook**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/cook/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/cook/workdir/style.css`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/cook/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/cook/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/cook/stderr.log`.
- **opencode**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/opencode/workdir/app.js`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/opencode/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/opencode/workdir/style.css`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/opencode/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/opencode/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/opencode/stderr.log`.
- **pi**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/pi/workdir/app.js`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/pi/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/pi/workdir/style.css`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/pi/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/pi/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T013120Z/pi/stderr.log`.
