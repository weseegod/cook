let meta = #{
    name: "learn-traces",
    description: "Map-reduce a collected set of Grok Build sessions into a curated list of harness changes: new or edited skills, plugin enables, deletes",
    when_to_use: "Launched by the /learn skill after collect_sessions.py has written a run directory. Not for direct use without that run directory.",
    phases: [
        #{ title: "Map", detail: "one agent per batch of sessions: phrases outside skills, skills and MCPs used, area, task type, friction" },
        #{ title: "Reduce", detail: "one agent per group of notes, repeated until one synthesis remains, with skill files as context" },
        #{ title: "Verify", detail: "three skeptics: phrases, stale skills, deletes" },
        #{ title: "Report", detail: "report.md for the user and actions.json for the apply step" },
    ],
};

// ---------------------------------------------------------------- args

fn trimmed(s) {
    if type_of(s) == "string" {
        s.trim();
        s
    } else {
        ""
    }
}

fn str_or(v, fallback) {
    let t = trimmed(v);
    if t == "" { fallback } else { t }
}

fn int_or(v, fallback) {
    if type_of(v) == "i64" && v > 0 { v } else { fallback }
}

fn pad4(n) {
    let s = n.to_string();
    while s.len() < 4 { s = "0" + s; }
    s
}

if args == () || args.run_dir == () || args.count == () || args.skill_dir == () {
    pause("verification", "Pass args.run_dir (collector output), args.count (sessions_kept from manifest.json), and args.skill_dir (directory holding report-format.md). Optional: batch (default 10), fan (default 10), today, user_label, focus; grok_home and python are accepted for compatibility and unused (the parent session owns state.json).");
}

let run_dir = trimmed(args.run_dir);
let skill_dir = trimmed(args.skill_dir);
let sep = if run_dir.contains("\\") { "\\" } else { "/" };
let grok_home = trimmed(args.grok_home);
let python = str_or(args.python, "python3");
let count = int_or(args.count, 0);
let batch = int_or(args.batch, 10);
let fan = int_or(args.fan, 10);
let today = str_or(args.today, "an unknown date");
let user_label = str_or(args.user_label, "the user");
let focus = trimmed(args.focus);

if count == 0 {
    pause("verification", "args.count is 0 or not an integer: pass manifest.sessions_kept as a number; if it is 0 the collector kept no sessions, so widen the window or check --grok-home.");
}

// ---------------------------------------------------------------- budget

let n_map = (count + batch - 1) / batch;
let reduce_total = 0;
let level = n_map;
loop {
    let groups = (level + fan - 1) / fan;
    reduce_total += groups;
    level = groups;
    if groups <= 1 { break; }
}
let needed = n_map + reduce_total + 3 + 1;
let b = budget();
if needed > b.remaining {
    pause("verification", "This run needs about " + needed.to_string() + " agents (" + n_map.to_string()
        + " map, " + reduce_total.to_string() + " reduce, 3 verify, 1 report) but the budget has "
        + b.remaining.to_string() + ". Relaunch with agent_budget >= " + needed.to_string()
        + " or a larger args.batch.");
}
log("Plan: " + count.to_string() + " sessions, " + n_map.to_string() + " map agents (batch " + batch.to_string()
    + "), " + reduce_total.to_string() + " reduce agents, 3 verify, 1 report; budget " + b.remaining.to_string());

// ---------------------------------------------------------------- schemas

let map_schema = #{
    "type": "object",
    "required": ["ok", "note", "sessions_read", "candidates"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "note": #{ "type": "string" },
        "sessions_read": #{ "type": "integer" },
        "candidates": #{ "type": "integer" },
    },
};

let reduce_schema = #{
    "type": "object",
    "required": ["ok", "note", "proposals"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "note": #{ "type": "string" },
        "proposals": #{ "type": "integer" },
    },
};

let verify_schema = #{
    "type": "object",
    "required": ["ok", "note", "kept", "dropped"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "note": #{ "type": "string" },
        "kept": #{ "type": "integer" },
        "dropped": #{ "type": "integer" },
    },
};

let report_schema = #{
    "type": "object",
    "required": ["ok", "report_path", "actions_path", "overview", "action_count"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "report_path": #{ "type": "string" },
        "actions_path": #{ "type": "string" },
        "overview": #{ "type": "string" },
        "action_count": #{ "type": "integer" },
    },
};

// ---------------------------------------------------------------- shared prompt text

fn rules(run_dir, today, user_label) {
    let p = "Today is " + today + ". You are one worker in a /learn run for " + user_label + ".\n";
    p += "Run directory: " + run_dir + "\n";
    p += "Rules:\n";
    p += "- Read files with tools before you write anything. A claim with no file behind it is invalid.\n";
    p += "- Do not edit skills, plugins, hooks, config, or traces. Write only inside the run directory.\n";
    p += "- Never print secrets: tokens, headers, env values, API keys, auth files. Config inventory is names only.\n";
    p += "- Quote session ids from the files. Do not invent ids, counts, or skill names.\n";
    p += "- Counts of skill, plugin, MCP, and workflow use come from usage.json. Do not recount them by hand.\n";
    return p;
}

let focus_line = "";
if focus != "" {
    focus_line = "\nExtra focus from " + user_label + ": " + focus + "\n";
}

// ---------------------------------------------------------------- Map

phase("Map");
let map_jobs = [];
let map_notes = [];
let m = 0;
while m < n_map {
    let first = m * batch;
    let last = first + batch - 1;
    if last > count - 1 { last = count - 1; }
    let note = run_dir + sep + "map" + pad4(first) + "-" + pad4(last) + ".md";
    let p = rules(run_dir, today, user_label);
    p += "\nYou are mapper " + (m + 1).to_string() + " of " + n_map.to_string() + ".\n";
    p += "Read every file in " + run_dir + sep + "sessions" + sep + " whose 4-digit prefix is between " + pad4(first) + " and " + pad4(last) + " inclusive (" + (last - first + 1).to_string() + " files). List the directory first, then read each file in full.\n";
    p += "Each file is one Grok Build session " + user_label + " sat at: `turns` (the human prompts, in order), `slash_commands`, `skills_loaded`, `mcp_servers_used`, `tools`, `top_dirs_touched`, `cwd`, `git_root`, `title`, `model`.\n";
    p += "Read " + run_dir + sep + "surfaces.json once so you know which skills exist and are loaded (name, path, source, loaded).\n";
    p += "Read " + skill_dir + sep + "signals.md: it defines what to extract (sections 1, 2, 3, 5) and the per-session record shape. Section 4 is not your job.\n";
    p += focus_line;
    p += "\nWrite " + note + " with one record per session in file order, in the shape signals.md gives, ending with `## Batch candidates`.\n";
    p += "\nReturn ok=true only after the note exists and sessions_read equals the number of files you read in full. candidates is the number of bullets under Batch candidates. If a file is missing or unreadable, say so in the note and set ok=false.";
    map_notes.push(note);
    map_jobs.push(#{
        prompt: p,
        label: "map:" + pad4(first) + "-" + pad4(last),
        capability_mode: "read-write",
        output_schema: map_schema,
    });
    m += 1;
}
// Waves of `fan`: a wave where every agent fails at once is the quota / outage signature (a run once spawned 63 doomed
// mappers after the balance hit HTTP 402). Stop spending there and hold for a resume; finished mappers replay from the journal.
let mapped = [];
let wave_start = 0;
let wave_no = 0;
while wave_start < map_jobs.len() {
    let take = if map_jobs.len() - wave_start < fan { map_jobs.len() - wave_start } else { fan };
    let wave_jobs = map_jobs.extract(wave_start, take);
    let res = parallel(wave_jobs);
    let ok = 0;
    for r in res { if r != () && r.success { ok += 1; } }
    if ok == 0 && res.len() >= 2 {
        log("Map wave " + wave_no.to_string() + ": all " + res.len().to_string() + " agents failed at once; stopping the fan-out");
        await_user("infra", "Every agent in a wave of " + res.len().to_string() + " failed at once — usually the usage balance is exhausted (HTTP 402) or the API is down. Nothing more is spent. Resume this run once the balance resets: finished mappers replay from the journal and this wave is retried.");
        res = parallel(wave_jobs);
    }
    for r in res { mapped.push(r); }
    wave_start += take;
    wave_no += 1;
}

let notes = [];
let lost_map = [];
let sessions_read = 0;
let mi = 0;
for r in mapped {
    // the note path is the one this script assigned; agent text is never used as a path
    if r != () && r.success && r.output != () && r.output.ok == true {
        notes.push(map_notes[mi]);
        if r.output.sessions_read != () { sessions_read += r.output.sessions_read; }
    } else {
        lost_map.push(map_jobs[mi].label);
    }
    mi += 1;
}
log("Map: " + notes.len().to_string() + "/" + n_map.to_string() + " notes, " + sessions_read.to_string() + "/" + count.to_string() + " sessions read");
if lost_map.len() > 0 {
    log("Map slots lost: " + lost_map.len().to_string());
}
if notes.len() == 0 {
    pause("verification", "Every map agent failed. Check the run directory and relaunch.");
}

// ---------------------------------------------------------------- Reduce

phase("Reduce");
let round = 1;
let lost_reduce = [];
loop {
    let jobs = [];
    let outs = [];
    let g = 0;
    let start = 0;
    while start < notes.len() {
        let stop = start + fan;
        if stop > notes.len() { stop = notes.len(); }
        let group = [];
        let k = start;
        while k < stop { group.push(notes[k]); k += 1; }
        let out = run_dir + sep + "reduce" + sep + "r" + round.to_string() + "-" + pad4(g) + ".md";
        let is_final = (notes.len() <= fan);
        let p = rules(run_dir, today, user_label);
        p += "\nYou are reducer " + (g + 1).to_string() + " in round " + round.to_string() + ".";
        if is_final { p += " This is the final round: your output is the synthesis the whole run will act on."; }
        p += "\nRead every one of these notes in full:\n";
        for n in group { p += "- " + n + "\n"; }
        p += "Then read " + run_dir + sep + "usage.json (deterministic use counts per skill, plugin, MCP, workflow; `unused_loaded`; `slash_commands_with_no_loaded_skill`; `mcp_servers_used_but_not_in_local_config`), " + run_dir + sep + "surfaces.json (what exists, paths, name collisions, plugins enabled but not installed), and " + run_dir + sep + "phrases.json (exact repeated prompts and repeated instruction lines with distinct-session counts).\n";
        p += "If " + run_dir + sep + "decisions.jsonl exists, read it: it holds prior /learn decisions. Never re-propose an action the user rejected. Mark an item already applied as applied instead of proposing it again.\n";
        p += focus_line;
        p += "Read " + skill_dir + sep + "signals.md for the definition of each section and the safety rules for unused surfaces.\n";
        p += "\nMerge the notes into " + out + " with these sections:\n";
        p += "## 1. Repeated phrases -> skills — one bullet per phrase: quoted phrase, distinct session ids, owner (existing loaded skill with path, or NEW <name>). Before naming an existing owner, open its SKILL.md and quote the line the phrase joins or that already covers it.\n";
        p += "## 2. Skills to update — one bullet per skill: path, the stale line quoted from the current file (open it; no line, no item), trace evidence with session ids, proposed replacement text.\n";
        p += "## 3. Unused -> delete or disable — from usage.json only, per signals.md section 4: name, kind, path, count, last_used, why removal is safe or `ask`. Put zero-use surfaces that share kind and disposition in one bullet listing the names, referrers in parentheses; one bullet per surface only when it needs its own reason.\n";
        p += "## 4. Gaps — recurring needs with no owner, with session ids.\n";
        p += "## Dropped — every candidate from the input notes you did not carry forward, with the reason.\n";
        p += "\nKeep every session id. Do not merge two different instructions into one phrase. Keep the file under 350 lines: the readers after you load it whole, and a longer file fails their read. Write it in pieces — one `write` call for sections 1 and 2, then `search_replace` on the last line to append sections 3 and 4 — and keep any single tool call under roughly 6,000 words: a call whose arguments exceed the model's output limit is cut off by the API (`max_tokens_truncation`) and the whole turn is lost. Put the Dropped section in a sibling file `" + out + ".dropped.md` and leave a one-line pointer to it. Return ok=true after the file exists; proposals is the number of bullets in sections 1-3.";
        outs.push(out);
        jobs.push(#{
            prompt: p,
            label: "reduce:r" + round.to_string() + "-" + pad4(g),
            capability_mode: "read-write",
            output_schema: reduce_schema,
        });
        g += 1;
        start = stop;
    }
    let reduced = parallel(jobs);
    let next = [];
    let ri = 0;
    for r in reduced {
        if r != () && r.success && r.output != () && r.output.ok == true {
            next.push(outs[ri]);
        } else {
            lost_reduce.push(jobs[ri].label);
        }
        ri += 1;
    }
    log("Reduce round " + round.to_string() + ": " + next.len().to_string() + "/" + jobs.len().to_string() + " notes");
    if next.len() == 0 {
        pause("verification", "Every reducer in round " + round.to_string() + " failed. Check the run directory and relaunch.");
    }
    notes = next;
    if notes.len() <= 1 || round >= 8 { break; }
    round += 1;
}
let synthesis = notes[0];
log("Synthesis: " + synthesis);

// ---------------------------------------------------------------- Verify

phase("Verify");
let vcommon = rules(run_dir, today, user_label);
vcommon += "\nYou are a skeptic. Read the synthesis at " + synthesis + " in full. Keep or drop claims; add none.\n";
vcommon += "Write your verdicts to the file named below as `## Kept` and `## Dropped` bullet lists that repeat the claim text and add a one-line reason. Create the file first and append a verdict after each claim, so a partial file survives if you are stopped. Check at most 40 claims; if the section has more, verify the 40 with the most sessions and list the rest under `## Unchecked`. Do not spend more than 25 tool calls in total. Return ok=true after the file exists, with kept and dropped counts.\n";

let v_phrases = vcommon;
v_phrases += "\nSection to verify: 1. Repeated phrases -> skills. Write " + run_dir + sep + "verify" + sep + "phrases.md\n";
v_phrases += "For each phrase: re-find it in " + run_dir + sep + "phrases.json or in the `turns` of the named session files under " + run_dir + sep + "sessions" + sep + ". Keep it only if at least 2 distinct sessions show it, or 1 session shows it and the user repeated it inside the session after a correction. Then grep the loaded skill files listed in " + run_dir + sep + "surfaces.json for the phrase's key words: if a loaded skill already states it, keep the item only with that skill as owner (correct the owner if the synthesis named NEW).";

let v_stale = vcommon;
v_stale += "\nSection to verify: 2. Skills to update. Write " + run_dir + sep + "verify" + sep + "stale.md\n";
v_stale += "For each item: open the skill file and confirm the quoted stale line exists now. Open the named session file(s) and confirm the trace evidence contradicts that line. Drop the item if either check fails. Drop an item whose skill file lives under installed-plugins/ unless the proposal is phrased as a user-skill override or an upstream change, because plugin sync overwrites direct edits there.";

let v_delete = vcommon;
v_delete += "\nSection to verify: 3. Unused -> delete or disable. Write " + run_dir + sep + "verify" + sep + "deletes.md\n";
v_delete += "For each item: confirm in " + run_dir + sep + "usage.json that count is 0 and the name is not in slash MRU (surfaces.json `slash_mru`). Confirm the safety claim by reading surfaces.json (a duplicate exists, a bundled or plugin copy stays, the plugin was never enabled). If the item is the only copy of a job, change the action to ask. If " + run_dir + sep + "decisions.jsonl exists and the user rejected the same delete before, drop the item.";

let verified = parallel([
    #{ prompt: v_phrases, label: "verify:phrases", capability_mode: "read-write", output_schema: verify_schema },
    #{ prompt: v_stale, label: "verify:stale", capability_mode: "read-write", output_schema: verify_schema },
    #{ prompt: v_delete, label: "verify:deletes", capability_mode: "read-write", output_schema: verify_schema },
]);
let verify_notes = [];
let verify_failed = [];
let vnames = ["phrases", "stale", "deletes"];
let vpaths = [run_dir + sep + "verify" + sep + "phrases.md", run_dir + sep + "verify" + sep + "stale.md", run_dir + sep + "verify" + sep + "deletes.md"];
let vi = 0;
for r in verified {
    if r != () && r.success && r.output != () && r.output.ok == true {
        verify_notes.push(vpaths[vi]);
        log("Verify " + vnames[vi] + ": kept " + r.output.kept.to_string() + ", dropped " + r.output.dropped.to_string());
    } else {
        verify_failed.push(vnames[vi]);
    }
    vi += 1;
}

// ---------------------------------------------------------------- Report

phase("Report");
let rp = rules(run_dir, today, user_label);
rp += "\nYou write the final /learn report and the machine-readable action list.\n";
rp += "Read " + skill_dir + sep + "report-format.md first and follow it exactly for both files.\n";
rp += "Inputs: the synthesis " + synthesis + ", the verifier files:\n";
for n in verify_notes { rp += "- " + n + "\n"; }
if verify_failed.len() > 0 {
    rp += "These verifier sections FAILED and are unverified: ";
    for n in verify_failed { rp += n + " "; }
    rp += ". Put every claim from those sections under `## Unverified claims` (not in sections 1-3) and set requires_confirmation=true on any action you still emit for them.\n";
}
rp += "Also read " + run_dir + sep + "manifest.json (coverage counts and params), " + run_dir + sep + "usage.json, and " + run_dir + sep + "surfaces.json.\n";
rp += "Only claims kept by a verifier go into sections 1-3. Dropped claims go under Dropped claims with their reasons.\n";
rp += "Coverage facts for this run: map notes lost = " + lost_map.len().to_string() + ", reduce notes lost = " + lost_reduce.len().to_string() + ", sessions read by mappers = " + sessions_read.to_string() + " of " + count.to_string() + ".\n";
rp += "For every action that edits a file, open that file and make `edit.anchor` an exact substring of it. For every create, write the complete SKILL.md content following the frontmatter shape of an existing user skill in surfaces.json.\n";
rp += "surfaces.json marks each skill with `protected` (plugin, bundled, git-tracked, or null) and `referenced_by` (loaded skills that name it). A protected skill is never edited or deleted in place: emit the action with `action: propose` and `requires_confirmation: true`, and say in `reason` whether the fix belongs in a user-skill override with the same name (plugin, bundled) or in a pull request (git-tracked). A delete of a skill with a non-empty `referenced_by` becomes `ask` and lists the referrers in `reason`.\n";
rp += "Check manifest.json `disuse_evidence` first: when `sufficient` is false the window cannot show disuse, so section 3 becomes `## 3. Not seen in this window` with no delete, disable, ask, or group action and the Overview quotes `disuse_evidence.reason`, per report-format.md.\n";
rp += "Group before you write: unused surfaces (count 0, not in slash MRU) that share a kind and a disposition become ONE action with `kind: group` and an `items` array, per report-format.md. A report that lists thirty separate asks for thirty zero-use plugin skills is wrong; it should list one group. Keep single actions only for items with evidence of use (count > 0) and for a surface whose kind has no other zero-use member; a referenced zero-use skill goes into the ask group of its kind with referenced_by in its item.\n";
rp += focus_line;
rp += "\nWrite " + run_dir + sep + "report.md and " + run_dir + sep + "actions.json.";
rp += " Every file you touch stays inside " + run_dir + "; do not delete files, and run no command that reaches outside the run directory — a command that needs the user's approval blocks this agent forever when the user is away. The parent session records the run as report_ready once both files exist.";
rp += "\nWork budget: read each input file once (the synthesis, the three verifier files, manifest.json, usage.json, surfaces.json, and the skill files you must anchor edits in) — at most 40 file reads in total. Write report.md first, then actions.json, with the `write` tool in one call each — never through a shell heredoc or a script, and never by pasting the content into chat; if a write fails, retry once with the same tool. The shell is for reading only (e.g. counting lines); it runs nothing that touches files. If you reach 40 reads or 80 tool calls without both files written, stop reading, write both files from what you already have, and say in the Overview which sections are incomplete. Runs have burned tens of millions of tokens re-reading the same files on this step; a shorter report is the correct outcome, an unwritten one is not.";
rp += " Return ok=true after both files exist, report_path, actions_path, the Overview text as overview, and action_count.";

log("Report: launching the report agent (synthesis " + synthesis + ", " + verify_notes.len().to_string() + " verifier files)");
// "all": edit tools and shell. The previous "execute" mode (shell, no edit tools) forced this agent to write report.md
// through heredocs and made the write-tool instruction below impossible to follow.
let report = agent(rp, #{ label: "report", capability_mode: "all", output_schema: report_schema });
if report == () {
    log("Report: the report agent did not start or returned nothing; the parent will hand over the synthesis at " + synthesis);
} else if !report.success {
    log("Report: the report agent failed after " + report.tokens_used.to_string() + " tokens; the synthesis at " + synthesis + " is the best available output.");
}

let overview = "The report agent did not return an overview.";
let report_path = run_dir + sep + "report.md";
let actions_path = run_dir + sep + "actions.json";
let action_count = 0;
if report != () && report.success && report.output != () {
    if report.output.overview != () { overview = report.output.overview; }
    if report.output.action_count != () { action_count = report.output.action_count; }
} else {
    overview = "The report step did not finish. The synthesis at " + synthesis + " holds the findings; the parent session presents it and offers to retry the report step.";
}

let scratch = write_scratch_file("report.md", overview + "\n\nFull report: " + report_path + "\nActions: " + actions_path);

complete(#{
    summary: overview,
    report_path: report_path,
    actions_path: actions_path,
    action_count: action_count,
    synthesis: synthesis,
    sessions_read: sessions_read,
    sessions_total: count,
    lost_map_slots: lost_map,
    lost_reduce_slots: lost_reduce,
    unverified_sections: verify_failed,
    scratch: scratch,
});
