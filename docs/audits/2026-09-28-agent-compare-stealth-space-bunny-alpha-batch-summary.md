# OpenRouter agent evaluation: stealth/space-bunny-alpha

Date: 2026-09-28  
Model: `stealth/space-bunny-alpha` via OpenRouter  
Agents: cook, opencode, pi  
Run mode: sequential, 1800-second timeout per agent, reasoning enabled

## Setup

The first easy/medium/hard attempts used the harness default `thinking=false`. OpenRouter rejected all three agents with HTTP 400: “Reasoning is mandatory for this endpoint and cannot be disabled.” Those attempts did not produce usable model runs. I reran them with `--thinking true`, then used the same setting for the three additional hard prompts requested afterward.

Each prompt below was sent unchanged to all three agents. The harness reports process exit status, elapsed time, model/tool usage, and git-visible files. An exit code of 0 and a file count do not establish that every requested feature works; no independent browser or gameplay verification was performed.

## Results by prompt

Each result cell is `exit code / files recorded`.

| Difficulty | Prompt | Cook | OpenCode | Pi | Detailed report |
| --- | --- | ---: | ---: | ---: | --- |
| Easy | Number guessing game | 0 / 1 | 0 / 1 | 0 / 2 | [Easy report](2026-09-28-agent-compare-stealth-space-bunny-alpha-004852.md) |
| Medium | To-do app | 0 / 3 | 0 / 3 | 0 / 3 | [Medium report](2026-09-28-agent-compare-stealth-space-bunny-alpha-005554.md) |
| Hard | Minesweeper | 1 / 0 | 0 / 4* | 0 / 0 | [Minesweeper report](2026-09-28-agent-compare-stealth-space-bunny-alpha.md) |
| Hard | Kanban board | 0 / 3 | 0 / 3 | 0 / 3 | [Kanban report](2026-09-28-agent-compare-stealth-space-bunny-alpha-013111.md) |
| Hard | Monthly event calendar | 1 / 2 | 0 / 3 | 0 / 3 | [Calendar report](2026-09-28-agent-compare-stealth-space-bunny-alpha-020424.md) |
| Hard | Personal finance dashboard | 1 / 3 | 0 / 3 | 0 / 3 | [Finance report](2026-09-28-agent-compare-stealth-space-bunny-alpha-024232.md) |

`*` OpenCode's four Minesweeper files include `test.headless.js` in addition to the three app files. Pi exited 0 on Minesweeper but left the work directory empty. Pi's two easy files include `test.js` in addition to `index.html`.

## Aggregate process results

| Agent | Exit 0 | Summed wall time across six prompts | Files recorded across six prompts |
| --- | ---: | ---: | ---: |
| Cook | 3 / 6 | 40m 54s | 12 |
| OpenCode | 6 / 6 | 47m 36s | 17 |
| Pi | 6 / 6 | 29m 59s | 14 |

File totals include agent-created test files where present. Across the 18 runs, OpenCode had an exit code of 0 on all six prompts and produced the requested app files in each run. Pi also exited 0 on all six, but produced no files for Minesweeper. Cook exited 0 on easy, medium, and Kanban; its other three hard runs exited 1.

## Recorded failures and limits

- Cook's Minesweeper run exited 1 and left no files. The detailed report has no further error explanation.
- Cook's calendar run exited 1 after the harness rejected a 32,828-byte tool call, above its 32,768-byte per-call limit; it left `index.html` and `style.css`, but no `app.js`.
- Cook's finance run exited 1 with `max turns reached`; it had created all three app files before the agent stopped.
- Pi's Minesweeper run exited 0 but created no files, so the status alone overstates completion.

The extra hard prompts were Kanban, monthly event calendar, and personal finance dashboard. All three were run against all agents with the same prompt and configuration.
