# Agent comparison: stealth/space-bunny-alpha

Wire model: `stealth/space-bunny-alpha`
Thinking: `true`
Parallel: `false`

Task:

> Easy: Create a polished, fully playable number guessing game in one self-contained index.html with inline CSS and JavaScript. Pick a random number from 1 to 100, accept guesses by button or Enter, show higher/lower hints and attempt count, validate input, and provide a restart button. No external dependencies.

| Agent | Wall s | Exit | Model calls | Tool calls | Uncached input | Output | Cache read | Cache write | Cache field | Files | Bytes | Output tokens/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cook | 211.34 | 0 | 36 | 35 | 23793 | 16624 | 865273 | 0 | present | 1 | 11324 | 78.66 |
| opencode | 80.14 | 0 | 20 | 20 | 8562 | 7301 | 248014 | 0 | present | 1 | 11156 | 91.1 |
| pi | 53.41 | 0 | 9 | 8 | 2871 | 6961 | 59820 | 0 | present | 2 | 17147 | 130.33 |

Metrics come from each agent's JSON output. `unreported` means the field was absent.
Files and bytes count git-visible regular files in each workdir.

## Outputs

- **cook**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004307Z/cook/workdir/index.html`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004307Z/cook/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004307Z/cook/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004307Z/cook/stderr.log`.
- **opencode**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004307Z/opencode/workdir/index.html`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004307Z/opencode/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004307Z/opencode/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004307Z/opencode/stderr.log`.
- **pi**: files `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004307Z/pi/workdir/index.html`, `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004307Z/pi/workdir/test.js`; workdir `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004307Z/pi/workdir`; raw output `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004307Z/pi/stdout.json`; errors `/Users/thanhbm/Projects/cook/temp/evaluate/20260928T004307Z/pi/stderr.log`.
