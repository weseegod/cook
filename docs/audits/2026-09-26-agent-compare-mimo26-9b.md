# Local agent comparison: mimo26-9b

Wire model: `mimo26`

Task:

> Create hello.html containing a complete HTML page with a funny story of about 200 words about a robot trying to bake a cake. Give it a title and readable styling.

| Agent | Wall s | Exit | Model calls | Tool calls | Uncached input | Output | Cache read | Cache write | Cache field | Files | Bytes | Output tokens/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cook | 205.35 | 1 | 1 | 1 | 14499 | 1187 | 0 | 0 | present | 1 | 3687 | 5.78 |
| opencode | 40.64 | 0 | 1 | 1 | 6529 | 1453 | 0 | 0 | present | 1 | 4117 | 35.75 |
| pi | 240.18 | 124 | 2 | 2 | 2683 | 9372 | 1464 | 0 | present | 1 | 3359 | 39.02 |

Metrics come from each agent's JSON output. `unreported` means the field was absent.
Files and bytes count git-visible regular files in each workdir.
