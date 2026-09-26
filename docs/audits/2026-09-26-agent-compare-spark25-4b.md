# Local agent comparison: spark25-4b

Wire model: `spark25`
Thinking: `false`
Parallel: `true`

Task:

> Create hello.html with one funny sentence about a robot baker.

| Agent | Wall s | Exit | Model calls | Tool calls | Uncached input | Output | Cache read | Cache write | Cache field | Files | Bytes | Output tokens/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cook | 13.92 | 0 | 2 | 1 | 14816 | 458 | 15154 | 0 | present | 1 | 868 | 32.91 |
| opencode | 10.22 | 0 | 1 | 1 | 6636 | 129 | 0 | 0 | present | 1 | 226 | 12.63 |
| pi | 9.52 | 0 | 2 | 1 | 108 | 173 | 3087 | 0 | present | 1 | 274 | 18.18 |

Metrics come from each agent's JSON output. `unreported` means the field was absent.
Files and bytes count git-visible regular files in each workdir.

## Outputs

- **cook**: files `/home/thanh/Projects/cook/temp/evaluate/20260926T142232Z/cook/workdir/hello.html`; workdir `/home/thanh/Projects/cook/temp/evaluate/20260926T142232Z/cook/workdir`; raw output `/home/thanh/Projects/cook/temp/evaluate/20260926T142232Z/cook/stdout.json`; errors `/home/thanh/Projects/cook/temp/evaluate/20260926T142232Z/cook/stderr.log`.
- **opencode**: files `/home/thanh/Projects/cook/temp/evaluate/20260926T142232Z/opencode/workdir/hello.html`; workdir `/home/thanh/Projects/cook/temp/evaluate/20260926T142232Z/opencode/workdir`; raw output `/home/thanh/Projects/cook/temp/evaluate/20260926T142232Z/opencode/stdout.json`; errors `/home/thanh/Projects/cook/temp/evaluate/20260926T142232Z/opencode/stderr.log`.
- **pi**: files `/home/thanh/Projects/cook/temp/evaluate/20260926T142232Z/pi/workdir/hello.html`; workdir `/home/thanh/Projects/cook/temp/evaluate/20260926T142232Z/pi/workdir`; raw output `/home/thanh/Projects/cook/temp/evaluate/20260926T142232Z/pi/stdout.json`; errors `/home/thanh/Projects/cook/temp/evaluate/20260926T142232Z/pi/stderr.log`.
