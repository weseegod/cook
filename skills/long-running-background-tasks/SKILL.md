---
name: long-running-background-tasks
description: >-
  Required reading before you start, watch, or wait on anything that keeps running after you launch it — background jobs, watchers, scheduled loops, CI, pull requests, training runs, dev servers, long builds. Read it before you launch such work and before you report on its state. Saying where a running job stands counts as working on it. Use when: about to launch, supervise, inspect, diagnose, or report on work that keeps running after it is started.
---

# Working with long-running background tasks

Only submitting or queuing jobs is not sufficient to complete the task. The definition of done is the job has completed successfully and you have verified that it has produced all the expected outputs.

This means you must see through the jobs completion by watching the job to ensure that its healthy, progressing, and working as intended.

## Tools available

There's two ways to watch jobs: monitor and loop. Decide which of the two you need, sometimes you need both.

### monitor — deterministic, actionable events

- Use a monitor when the event is a predicate a script can evaluate — an API response, an exit code, a port answering.
- Typical events: CI turning red, a PR comment or merge conflict, a PR becoming ready to merge, a dev server coming up or going down, a job reaching a terminal state.
- The monitor requires a script polls on a fixed cadence and stays silent until the predicate fires, so an idle job costs nothing. More on writing good monitoring scripts below.
- Examples of when to use:
  - Monitoring a PR — wake on CI breaking, merge conflicts, etc.
  - Checking if local tooling is up — wake on the service being unavailable, errors, etc.
  - All of these wakeup cases can be checked deterministically.

### loop — qualitative health that needs reading

- Use a loop when judging health requires reading the logs and system information to detect failing, faulty or stalled jobs. It uses a subagent which is more expensive but more thorough.
- Typical signals: the loss curve going unstable, a filtering pipeline producing garbage, throughput quietly degrading, faulty nodes throwing CUDA errors.
- A subagent reads the logs on a fixed cadence (say every 10 min) and reports what changed, so it costs a wakeup every cycle.
- Examples of when to use:
  - Checking on a training or data processing job — the subagent should scan for instability, degradation, faulty nodes, etc.
  - Monitoring system deployment health — the subagent should scan for 4xx/5xx, response times, resources, etc.
  - All of these wakeup cases are hard to describe deterministically and hard to fully enumerate, so it is better to use a subagent to validate.

## Good monitoring scripts

The monitor tool wakes you up every time you log to stdout. Wakeups are expensive, so only log if there is something actionable — but log it as early as possible, since staying silent delays the task. Plan accordingly: minimize the number of wakeups while still firing them as quickly as possible.

### Planning

- Enumerate all terminal conditions.
  - For PRs, this includes the PR being merged or closed.
  - For long-running jobs, this includes the job completing or unrecoverable failures.
- Enumerate all other situations where a wakeup is needed.
  - For PRs, this would include when a comment arrives (there are four different types of PR comments), when CI fails, when a merge conflict arises, and when the PR becomes ready to merge (CI green, no conflicts, reviews complete, no blockers).
  - For an ML training job, this can be when the loss is unstable or the instance is preempted.
- Determine situations where the monitoring has to update what it is tracking. For example, for monitoring PRs, the latest commit hash may change as you push new commits.

### Writing

- The monitoring script should poll every 30s. `watch_pr.py` defaults to
  `--poll-interval 30`. Lower intervals cause GitHub rate limits, especially
  with more than one watcher on the same token.
- Based on the planning, exit immediately on terminal conditions with FAILED, DONE, or CANCELLED, and log ACTION_REQUIRED for wakeups.
- Send all debug diagnostics — both your watcher's own trace and the monitored job's output — to a file, so a log line can never be mistaken for DONE, FAILED, or CANCELLED.
- The script should fail as early as possible. Emit a FAILED token immediately when any required condition reaches terminal failure. For example, if you are waiting on CI and any of them fail, emit FAILED immediately.
- Write the script to a durable location such as ~/.grok and name it something clear such as `ci_watcher.sh`.
- Key every log file the script writes on the pid or session id of the thing being watched. The paths are otherwise fixed, so a second job of the same kind silently clobbers the first one's log.

## Handling wake-ups

- Address errors or actionable events immediately. Look through the logs and debug the issue thoroughly before settling on a root cause, as long-running processes are generally expensive. Resubmit the job once it is fixed:
  - For PRs, this means repushing the changes and restarting CI (if needed).
  - For jobs, requeue or relaunch the job.
  - Always restart the monitor or loop so that it points at the new PR or job.
- If there are multiple jobs running, start debugging immediately when any jobs fail. Minimize total wall-time with completing tasks.

## Restarts

- Whenever you relaunch a job, always update the monitor.
- Monitors have a maximum 10-hour time limit, so be sure to restart them if you hit the time limit and if the task being monitored is still running.
- When you spawn a new monitor, make sure to kill any previous ones that the new one replaces. For example, if you fix a training run and respawn it, be sure to kill previous monitors, as irrelevant wakeups are expensive.

## Cleanup

- If a monitor is in a terminal state, kill the monitor, the loop, and the job. Dangling processes such as unkilled broken training runs are expensive. Then, address all issues if present.
- If an outdated monitor wakes you — that is, it is attached to an old or dead run — make sure to kill it.
- Do not leave detached workers, duplicate pollers, or orphaned watcher processes behind.

## Examples

### Example: maintaining a dev server

Suppose you just made some changes to the user's frontend code and would like to spin it up to test it. While you're testing it, you would like to know if the server goes down for any reason (if you made changes, for example). This is a great use case for the monitor tool. First start a React app in a background terminal, which reports its pid:

```
run_terminal_command(
  command="echo $$; npm start >~/.grok/long-running-background-tasks/dev_server_$$.log 2>&1",
  timeout=0,
  description="Start the dev server on :3000",
  background=true
) # prints the pid 123456789
```

There are no terminal states, but there are two actionable events from the watcher: `http://localhost:3000` coming up and going down.

You want to be notified as soon as it is up so you can use it, and you want to be woken when it stops so you can address it — fix the code, restart the server, free the port. Both down paths quote the tail of the server's log, so the wakeup arrives with the error already in hand. Polling every 5s is a good cadence since you want to quickly fix it if it is down, and it is not expensive to poll.

```bash
#!/usr/bin/env bash
# Log paths are keyed on the server pid so two dev servers cannot clobber each other.
PID=$1 URL=http://localhost:3000 DIR=~/.grok/long-running-background-tasks
LOG=$DIR/dev_server_$PID.log
up() { curl -fsS -o /dev/null --max-time 5 "$URL" 2>>"$DIR/watch_dev_server_$PID.log"; }
why() { tail -20 "$LOG" | tr -d '\r' | tr '\n' ' '; }

until up; do
  kill -0 "$PID" 2>/dev/null || { echo "FAILED: pid $PID exited before $URL came up: $(why)"; exit 1; }
  sleep 5
done
echo "ACTION_REQUIRED: $URL is up"

while :; do
  sleep 5
  up || { echo "ACTION_REQUIRED: $URL is down: $(why)"; until up; do sleep 5; done; }
done
```

To spawn the monitor, point it at the pid `npm start` reported:

```
monitor(
  command='bash ~/.grok/long-running-background-tasks/watch_dev_server.sh 123456789',
  description="Watch the dev server on :3000"
)
```

On the first wakeup the app is ready to use and you can start testing it. After that, you may be woken up if the server goes down. When you do:
- Read `~/.grok/long-running-background-tasks/dev_server_<pid>.log` for the full compile error or port conflict and fix it.
- If the dev server survived, hot reload picks the fix up and the watcher recovers on its own, so leave the monitor running.
- If the process is dead, restart it with a fresh `run_terminal_command`, then kill this monitor and spawn a new one against the new pid.

### Example: PR monitoring

PR monitoring should stop when the PR is merged or closed, and it should wake up on:
- For comments, you should ask users how they would like to resolve them (which ones to address automatically, whether to respond / resolve, etc.), then store the decision for new future sessions. There are four different types of PR comments.
  - Inline review threads
  - Review bodies
  - Conversation comments
  - Commit comments
- Failing CI - most can be fixed in the code but sometimes they may be flaky. For flaky CI, just rerun them.
- Merge conflicts
- The PR becoming ready to merge — CI passes, no merge conflicts, reviews complete, no blockers, no unresolved inline threads. That wakeup is `kind: mergeable`. Tell the user they can merge now. It is not terminal; keep watching until merge or close.

You can find the example script bundled with this skill at watch_pr.py. It needs an authenticated `gh` CLI (`gh auth login`) and `python3`. Default poll is 30s; a lower poll rate may hit GitHub rate limits at higher concurrency.

```
monitor(
  command='python3 ~/.grok/long-running-background-tasks/watch_pr.py "https://github.com/xai-org/grok-build/pull/123"',
  description="Watch PR 123"
)
```

### Example: training monitoring

For monitoring long training jobs, the terminal conditions are when the job either fails or completes. Further, many issues cannot be caught deterministically, so use a subagent to run a script for most of the high-level update, then scan the logs for errors such as faulty nodes or CUDA warnings.

The script below is bundled with this skill as watch_training.py. Run it with `--help` for every flag and for the run-directory and log-line layout it expects, since it parses nanoGPT stdout out of a Slurm run dir.

```md
Keep an eye on the nanoGPT run nanogpt_owt_124m_r1 (slurm job 1234567) and tell me what changed since last time. Worktree ~/worktrees/nanogpt-owt-124m.

1. python3 ~/.grok/skills/long-running-background-tasks/watch_training.py --run-name nanogpt_owt_124m_r1 --job-id 1234567 --target-val 3.00

How to report:
- Start with the job's state and if it changed, e.g. "still RUNNING" or "PENDING -> RUNNING".
- Copy the ISSUES line and the STATUS line from the monitor exactly as it is written, numbers and all. STATUS will include where the run is heading: how far along, iters left, the eta, and whether val loss is still coming down. We want val loss at or under 3.00.
- If the state didn't change, tell me that in one line and stop.
- If the job has finished or died, give me the state, the exit code, and the last ISSUES, and run these two for me:
  sacct -j 1234567 -D -X -P -o JobID,State,ExitCode,DerivedExitCode,Elapsed,NodeList,FailedNode
  tail -20 ~/train_logs/slurm-nanogpt_owt_124m_r1-1234567.out

Keep <=10 lines: state, progress and eta, loss trend, then anything that smells like training going unstable (loss spiking, NaN, val loss creeping back up) or the cluster misbehaving (a drained or failing node, OOM, NCCL errors, a preemption, iters suddenly slower than usual).
```

Launch the scheduler on a 10 min interval, and spawn a monitor to be notified when the job crashes or succeeds.

```
scheduler_create(
  interval="10m",
  prompt: "...", # Copy from the prompt above.
)
monitor(
  # Wakes on pending/running/finished changes after the first observation.
  # First poll is silent unless the job is already COMPLETED or failed —
  # PENDING matches *ING, so treating an empty previous state as a
  # transition would wake immediately on a just-submitted job.
  command='J=1234567; p=; while :; do s=$(sacct -nXP -j $J -o State|head -1); s=${s%% *}; s=${s:-PENDING}; if [ "$s" != "$p" ]; then case $s in COMPLETED) echo "DONE: $J"; exit;; PENDING|RUNNING|CONFIGURING|COMPLETING|REQUEUED|SUSPENDED|RESIZING) [ -n "$p" ] && echo "ACTION_REQUIRED: $J $p -> $s";; *) echo "FAILED: $J $s"; exit 1;; esac; fi; p=$s; sleep 30; done',
  description="Watch training run"
)
```

Launch both, so that we know when the job completes. When the monitor reports that the job has completed, cancel both the monitor and the scheduler, then determine next steps. Then:
- If it succeeded, simply present the results to the user.
- If it failed, debug the issue thoroughly, then fix and relaunch the job with new monitors attached. Make sure to have a thorough understanding of the issue before resubmitting, since training jobs are expensive. But always relaunch jobs so you don't waste the user's time.
