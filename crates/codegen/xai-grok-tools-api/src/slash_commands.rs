//! Canonical slash-command wording (`/loop`, `/imagine`, `/imagine-video`, `/goal`),
//! shared by every front-end (Grok Build shell/pager and other hosts) so
//! expansions cannot drift.

/// Canonical tool name advertised by the scheduler create tool. Gating code
/// (shell `CommandAvailability`, pager `required_tools`, host command lists)
/// keys `/loop` availability on this name.
pub const SCHEDULER_CREATE_TOOL_NAME: &str = "scheduler_create";

/// Usage hint shown when `/loop` is invoked with no arguments.
pub fn loop_usage_message() -> &'static str {
    "Usage: /loop [interval] <prompt>\n\
     Example: /loop 30m check deploy status\n\
     Example: /loop check deploy status every hour\n\n\
     Tell me how often it should run (e.g. 30m, 1 hour, every 2 days)."
}

/// Build the model instruction that `/loop` expands into for `args`. The model, not brittle host
/// parsing, turns the request into the `scheduler_create` interval, accepting every natural
/// phrasing and erroring on bad input rather than silently defaulting. See [`loop_usage_message`].
pub fn loop_schedule_instruction(args: &str) -> String {
    let fire_context = "Each fire runs in a detached background subagent, not in this conversation,\n\
         so the prompt you store must stand on its own.\n\n\
         ## Writing a prompt that survives a fresh fire\n\
         - Inline the state a fire needs: paths, job/PR/branch ids, the command that checks\n\
           status, and what \"healthy\" looks like. A fire cannot see this conversation, and\n\
           a long-running task restarts from a short summary every few iterations.\n\
         - Only a short status comes back here, so say what that status must contain.";
    format!(
        "# /loop -- schedule a recurring prompt\n\n\
         Turn the input below into a scheduler_create call. {fire_context}\n\
         - Say what one fire does and when it bails: \"if still pending, report one line and\n\
           stop.\" A fire must not poll inline.\n\
         - Give it a stop condition and an exit: \"when <condition> holds, report it and call\n\
           scheduler_delete <task_id>.\" Without that the loop runs until it expires.\n\
         - Keep it short and concrete -- the stored prompt is re-sent on every fire.\n\n\
         ## Deriving the interval\n\
         Convert the user's cadence -- however phrased, at either end of the request -- into a\n\
         compact `<number><unit>` string (`s`/`m`/`h`/`d`); the remaining text is the prompt.\n\
         The minimum is 60 seconds and shorter values are raised, so say so when it applies.\n\
         If no cadence is given, ask the user how often it should run -- never invent one.\n\n\
         ## Action\n\
         Schedule from what the user already gave you \u{2014} do not explore the workspace or run\n\
         checks before scheduling; the first fire does that.\n\
         1. Call scheduler_create with the interval, the prompt, and fire_immediately: true.\n\
            If the interval is rejected, fix the string rather than guessing.\n\
         2. Confirm what's scheduled, the cadence, its stop condition, that it auto-expires\n\
            after 7 days, and the task_id to cancel with scheduler_delete.\n\
         3. Do NOT execute the prompt inline. The scheduler fires it immediately.\n\n\
         ## Wrong tool for the job\n\
         - \"Tell me when X finishes\" -> a background command or watch tool that wakes you on\n\
           the event, not a recurring loop that re-checks on a timer.\n\
         - \"Do X once in N minutes\" -> background `sleep <secs> && <command>`; scheduling is\n\
           recurring-only.\n\n\
         ## Changing an existing loop\n\
         Call scheduler_create with its task_id and only the changed fields; do not\n\
         delete and recreate. If later work changes what a loop should do, update its\n\
         prompt the same way.\n\n\
         ## Input\n\
         {args}"
    )
}

/// Canonical name of the image generation tool; gates `/imagine`.
pub const IMAGE_GEN_TOOL_NAME: &str = "image_gen";

/// Advertised name of the /imagine command.
pub const IMAGINE_COMMAND_NAME: &str = "imagine";

/// Canonical name of the image-to-video tool; gates `/imagine-video`.
pub const IMAGE_TO_VIDEO_TOOL_NAME: &str = "image_to_video";

/// Advertised name of the /imagine-video command.
pub const IMAGINE_VIDEO_COMMAND_NAME: &str = "imagine-video";

/// Usage hint shown when `/imagine` is invoked with no arguments.
pub fn imagine_usage_message() -> &'static str {
    "Usage: /imagine <description>\n\
     Provide a text description to generate an image."
}

/// Build the model instruction that `/imagine` expands into for `prompt`.
pub fn imagine_instruction(prompt: &str) -> String {
    format!(
        "Call the image_gen tool immediately, passing the user's prompt below \
         verbatim — do not rewrite, embellish, or expand it. \
         After the tool completes, briefly acknowledge and mention \
         where the image was saved.\n\n\
         Prompt: {prompt}"
    )
}

/// Usage hint shown when `/imagine-video` is invoked with no arguments.
pub fn imagine_video_usage_message() -> &'static str {
    "Usage: /imagine-video <description>\n\
     Provide a text description to generate a video."
}

/// Build the model instruction that `/imagine-video` expands into for `prompt`.
pub fn imagine_video_instruction(prompt: &str) -> String {
    format!(
        "{IMAGINE_VIDEO_SKILL}\n\n\
         User prompt: {prompt}"
    )
}

/// Video workflow guidance injected by `/imagine-video`.
const IMAGINE_VIDEO_SKILL: &str = "\
# Imagine Video

Video starts from an image — there is no text-to-video tool. \
Default to `image_to_video`; use `reference_to_video` when the user \
explicitly asks for it, a shot genuinely needs multiple reference images, \
or the subject should speak in a specific preset voice (`voices`).

If a video tool fails with a zero-data-retention (ZDR) storage error, relay \
that error verbatim and stop the workflow — do not generate more source \
images or retry.

## Default: single clip

Unless the user asks for a long video, multiple scenes, or a multi-shot sequence, \
generate **one** video:

1. Create a source image with `image_gen` that stages the first frame \
(composition, subject, lighting).
2. Call `image_to_video` with that image and a short prompt describing the motion \
or camera move (1–2 sentences, present tense).
3. After the tool completes, mention the saved file path so the user can find it.

## Longer / multi-shot videos

When the user requests a longer video, multiple scenes, or a narrative sequence:

1. **Plan the story as shots** — break the idea into distinct shots, one beat each.
2. **Favor frequent, short shots** — prefer more 6s clips over fewer long ones; more cuts keep it dynamic.
3. **Create each shot's source image** with `image_gen` (or `image_edit` to combine references), keeping characters and settings consistent across shots.
4. **Animate each shot with `image_to_video`** — the source image becomes frame 1.
5. **Assemble with FFmpeg** using stream copy (`ffmpeg -f concat ... -c copy` — never re-encode). \
Keep every shot at the same resolution and frame rate so the concat works. \
After assembly, mention the final output path.

## Shot guidance

- **Prompt-craft:** one short, vivid moment in present tense with a clear camera movement, in 1–2 sentences.
- **Minimal but interesting:** one clear subject, one simple motion or camera move per shot. Avoid complex multi-action animation; make the shot compelling through composition, lighting, and a strong moment.
- **Complex source image?** Intricate frames (busy geometry, fine detail, heavy reflections) warp when animated. Keep the subject fixed and move only the camera (slow push-in, orbit, or parallax), or break into simpler shots. For new shots, generate a simpler, animation-friendly base image rather than animating a busy one.
- **`image_to_video` animates from frame 1** — stage the first frame with `image_gen`/`image_edit` before animating.
- **Aspect ratio:** set it on the source image (`image_gen` `aspect_ratio`); don't re-crop an existing video.
- **Duration:** 6s or 10s only (prefer 6s); round to the nearest. `reference_to_video` accepts 1–15s.
- **Speaking subjects:** to give a subject a voice, use `reference_to_video` with `voices` (up to 3 preset voice identifiers, e.g. \"ara\", \"eve\") and tag them in the prompt as `<AUDIO_0>`…; combine with reference `images` tagged `<IMAGE_0>`… for a consistent character.
- **Real people:** reference-first — drive the video from a verified reference image; never animate a named person without one.
- Don't loop the same clip unless asked.";

/// Advertised name of the `/commit` command.
pub const COMMIT_COMMAND_NAME: &str = "commit";

/// Advertised name of the `/commit-and-push` command.
pub const COMMIT_AND_PUSH_COMMAND_NAME: &str = "commit-and-push";

/// Usage hint for a bare `/commit --help`-style mistake.
pub fn commit_usage_message() -> &'static str {
    "Usage: /commit [message hint]\n\
     Stage the current changes and commit them with a generated message."
}

/// Usage hint for a bare `/commit-and-push --help`-style mistake.
pub fn commit_and_push_usage_message() -> &'static str {
    "Usage: /commit-and-push [message hint]\n\
     Commit the current changes and push them."
}

/// Push-only section appended when `push` is set.
///
/// The push never integrates the upstream branch: a rejection that needs a pull is reported, not
/// resolved. That keeps the commit turn from turning into an unbounded conflict-resolution run.
const COMMIT_PUSH_SECTION: &str = "\n## Then push\n\
     After the commit, push it:\n\
     1. `git push`; when the branch has no upstream yet, `git push -u origin HEAD`.\n\
     2. Never add `--force` or `--force-with-lease`.\n\
     3. A push rejected because the remote branch has commits this branch does not: do NOT pull, \
        merge, rebase, or resolve conflicts. Leave the commit in place, report the rejection \
        verbatim, and stop.\n\
     4. A push that fails on auth or network: report the error verbatim and leave the commit in \
        place.\n";

/// How the plan for the current changes reaches the commit turn.
///
/// The commit turn never sees the parent conversation, so the plan is the only place the *reason*
/// for the change survives. [`CommitPlan::Body`] inlines a small plan; [`CommitPlan::Path`] points
/// at one too large to inline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitPlan<'a> {
    /// The plan body, inlined because it is small.
    Body(&'a str),
    /// The plan file's path, when the body is too large to inline.
    Path(&'a str),
}

/// Build the model instruction that `/commit` (and `/commit-and-push`) expand into, with no plan.
///
/// See [`commit_instruction_with_plan`] for the plan-carrying variant.
pub fn commit_instruction(hint: &str, push: bool) -> String {
    commit_instruction_with_plan(hint, push, None)
}

/// Build the model instruction that `/commit` (and `/commit-and-push`) expand into.
///
/// `hint` is the user's optional steer for the message; `push` appends the push section; `plan`
/// carries the plan for the current changes when the session has one.
///
/// The instruction runs in a fresh turn with no parent conversation: the model writes the message
/// from the plan and the working tree, never from chat history it cannot see.
pub fn commit_instruction_with_plan(
    hint: &str,
    push: bool,
    plan: Option<CommitPlan<'_>>,
) -> String {
    let hint = hint.trim();
    let hint_line = if hint.is_empty() {
        String::new()
    } else {
        format!(
            "\nThe user supplied this steer for the message: \"{hint}\". When it already reads as a \
             complete subject line, use it (fix only capitalization and punctuation); otherwise \
             treat it as emphasis and still write the message from the actual changes.\n"
        )
    };
    let plan_section = match plan {
        Some(CommitPlan::Body(body)) => format!(
            "\n## The plan for these changes\n\
             This plan is the specification for the work being committed:\n\n{body}\n"
        ),
        Some(CommitPlan::Path(path)) => format!(
            "\n## The plan for these changes\n\
             Read the plan at {path} before writing the message; it is the specification for the \
             work being committed.\n"
        ),
        None => "\n## The plan for these changes\n\
                 No plan is attached to this session. Write the message from the diff.\n"
            .to_string(),
    };
    let push_section = if push { COMMIT_PUSH_SECTION } else { "" };
    format!(
        "# /commit -- commit the current changes\n\n\
         Commit the work in this workspace now. This is a fresh turn: you do NOT have the \
         conversation that produced these changes, and nothing from it is available to you. \
         Everything you need is the plan below (when present) and the working tree. Everything \
         below is one turn: do not end it until the commit exists or you have reported why it \
         cannot.{hint_line}{plan_section}\n\
         ## Message\n\
         - Write it from the plan and the actual diff: the plan says why the change exists, the \
           diff says what changed. Do not guess beyond them.\n\
         - Match the style of recent history (`git log -5 --oneline`): conventional-commit prefixes \
           only when the log already uses them.\n\
         - Subject: imperative, at most 72 characters, no trailing period. Add a body only when the \
           reason is not obvious from the subject.\n\
         - No attribution trailers (\"Made-with\", co-author) unless this repository already uses \
           them.\n\n\
         ## How to commit\n\
         1. One compact probe, color off: `git -c color.ui=false -c color.diff=false status \
            --porcelain`, `git -c color.ui=false -c color.diff=false diff --stat HEAD`, and \
            `git log -5 --oneline`. Read a file's full diff only when the plan and the stat do not \
            explain that file.\n\
         2. Nothing modified or staged: say so and stop.\n\
         3. A merge, rebase, cherry-pick, or bisect already in progress: report it and stop; do not \
            start a commit on top of it.\n\
         4. Stage the changes that belong in this commit. Keep secrets (`.env`), dependencies \
            (`node_modules/`), and build output out of it.\n\
         5. Write the message to a file with the write tool, then run `git commit -F <file>`. Do not \
            pass a multi-line `-m`, and do not use a shell heredoc: `<<` is not portable and quoting \
            breaks the message. Do not add `--no-verify`, `--amend`, or `--allow-empty` unless the \
            user asked.\n\
         6. Report the short hash, the subject, and the branch state (`git status -sb`).\n\
         {push_section}\n\
         ## Rules\n\
         - Never force-push, never rewrite published history, and never drop a commit to make a \
           command succeed.\n\
         - Run git commands one at a time; do not start a second mutating command while one runs.\n\
         - No subagents and no extra summary call: this command must not cost a model round-trip of \
           its own.\n"
    )
}

/// Parsed `/commit`-family arguments, shared by every front-end so the flag grammar cannot drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommitArgs<'a> {
    /// The user's message steer, with any trailing `--push` removed.
    pub hint: &'a str,
    /// Whether to integrate and push (`/commit-and-push`, or a trailing `--push`).
    pub push: bool,
    /// `--help` / `-h`: show usage instead of running.
    pub help: bool,
}

/// Parse `/commit` arguments. `force_push` is the command's own meaning
/// (`/commit-and-push` sets it); a trailing standalone `--push` token sets it too.
/// A hint that merely mentions `--push` mid-sentence is left untouched.
pub fn parse_commit_args(args: &str, force_push: bool) -> CommitArgs<'_> {
    let trimmed = args.trim();
    if matches!(trimmed, "--help" | "-h") {
        return CommitArgs {
            hint: "",
            push: force_push,
            help: true,
        };
    }
    let (hint, flag_push) = split_trailing_push_flag(trimmed);
    CommitArgs {
        hint,
        push: force_push || flag_push,
        help: false,
    }
}

/// Split a trailing standalone `--push` token off `args`.
fn split_trailing_push_flag(args: &str) -> (&str, bool) {
    let Some((raw_head, tail)) = args.rsplit_once("--push") else {
        return (args, false);
    };
    if !tail.trim().is_empty() {
        return (args, false);
    }
    let head = raw_head.trim_end();
    if head.is_empty() || raw_head.ends_with(char::is_whitespace) {
        return (head, true);
    }
    (args, false)
}

pub const UPDATE_GOAL_TOOL_NAME: &str = "update_goal";

pub const WORKFLOW_TOOL_NAME: &str = "workflow";

pub const GOAL_COMMAND_NAME: &str = "goal";

/// Bare subcommand tokens reserved for goal lifecycle control rather than
/// being treated as an objective, matching the shell's /goal grammar.
pub const GOAL_RESERVED_SUBCOMMANDS: &[&str] = &["status", "pause", "resume", "clear", "edit"];

pub fn goal_usage_message() -> &'static str {
    "Usage: /goal <objective>\n\
     Set an objective to work toward until it is complete."
}

pub fn goal_instruction(objective: &str) -> String {
    format!(
        "# /goal -- pursue an objective\n\n\
         A goal has been set: {objective}\n\n\
         Work directly on this goal and carry it as far as you can. Deliver \
         everything the user asked for yourself: no follow-up questions, no \
         manual steps left for the user. If the conversation continues, keep \
         pursuing the goal until it is complete.\n\n\
         TRACKING: break the objective into concrete steps and track them \
         (use your todo tool if one is available), marking each done as you \
         finish it.\n\n\
         VERIFY AS YOU GO: do not start the test runner after each edit. \
         If other work can continue, run the check in the background and read \
         the result once when it arrives. Do not sleep-loop for status. A check \
         already run on the unchanged final tree counts. A completion claim must be \
         backed by evidence produced in this session, not assumptions.\n\n\
         Call update_goal(completed: true, message: \"summary\") ONLY when the \
         goal is fully achieved. Call update_goal(blocked_reason: \"reason\") \
         only when truly stuck after 3+ consecutive failed attempts at the \
         same problem. Call update_goal(message: \"status note\") to log \
         progress along the way. If update_goal returns an error, continue \
         working the goal and report status in your reply instead.\n\n\
         Start now."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imagine_instruction_carries_prompt_verbatim() {
        let text = imagine_instruction("a golden sunset");
        assert!(text.contains("a golden sunset"));
        assert!(text.contains("image_gen"));
    }

    #[test]
    fn imagine_video_instruction_carries_prompt_and_workflow() {
        let text = imagine_video_instruction("a cat playing piano");
        assert!(text.contains("a cat playing piano"));
        assert!(text.contains("image_to_video"));
    }

    #[test]
    fn commit_instruction_covers_both_variants() {
        let plain = commit_instruction("", false);
        assert!(!plain.contains("## Then push"));
        assert!(plain.contains("git commit -F <file>"));
        assert!(plain.contains("Never force-push"));
        assert!(plain.contains("no extra summary call"));
        // The fresh-turn contract: no parent conversation, no full-patch dump.
        assert!(plain.contains("you do NOT have the conversation"));
        assert!(plain.contains("No plan is attached to this session"));

        let push = commit_instruction("ship the widget", true);
        assert!(push.contains("## Then push"));
        assert!(push.contains("git push -u origin HEAD"));
        assert!(push.contains("ship the widget"));
        assert!(!plain.contains("ship the widget"));
    }

    #[test]
    fn commit_instruction_stops_push_when_it_needs_a_pull() {
        let push = commit_instruction("", true);
        assert!(push.contains("do NOT pull, "));
        assert!(push.contains("report the rejection "));
        assert!(push.contains("verbatim"));
        // The retired integrate-then-push flow must not be referenced.
        assert!(!push.contains("git pull"));
        assert!(!push.contains("git fetch"));
        assert!(!push.contains("--diff-filter=U"));
        assert!(!push.contains("rebase --continue"));
    }

    #[test]
    fn commit_instruction_attaches_the_plan_by_body_or_path() {
        let body = commit_instruction_with_plan("", false, Some(CommitPlan::Body("# Plan: fix it")));
        assert!(body.contains("# Plan: fix it"));
        assert!(body.contains("This plan is the specification"));

        let path = commit_instruction_with_plan(
            "",
            false,
            Some(CommitPlan::Path("plans/fix-it.md")),
        );
        assert!(path.contains("Read the plan at plans/fix-it.md"));
        assert!(!path.contains("No plan is attached"));
    }

    #[test]
    fn commit_usage_messages_name_their_command() {
        assert!(commit_usage_message().contains("Usage: /commit "));
        assert!(commit_and_push_usage_message().contains("Usage: /commit-and-push "));
    }

    #[test]
    fn parse_commit_args_handles_push_flag_and_help() {
        assert_eq!(
            parse_commit_args("", false),
            CommitArgs {
                hint: "",
                push: false,
                help: false
            }
        );
        assert_eq!(
            parse_commit_args("fix the parser", false),
            CommitArgs {
                hint: "fix the parser",
                push: false,
                help: false
            }
        );
        assert_eq!(
            parse_commit_args("fix the parser --push", false),
            CommitArgs {
                hint: "fix the parser",
                push: true,
                help: false
            }
        );
        assert_eq!(
            parse_commit_args("--push", false),
            CommitArgs {
                hint: "",
                push: true,
                help: false
            }
        );
        // The command's own meaning wins even with no flag.
        assert_eq!(parse_commit_args("fix it", true).push, true);
        assert_eq!(parse_commit_args("--help", false).help, true);
        assert_eq!(parse_commit_args("-h", true).help, true);
    }

    #[test]
    fn parse_commit_args_leaves_embedded_push_text_alone() {
        // A hint that mentions --push mid-sentence is not a flag.
        assert_eq!(
            parse_commit_args("document --push behavior", false),
            CommitArgs {
                hint: "document --push behavior",
                push: false,
                help: false
            }
        );
        assert_eq!(
            parse_commit_args("explain --push", false),
            CommitArgs {
                hint: "explain",
                push: true,
                help: false
            }
        );
    }

    #[test]
    fn instruction_carries_args_and_contract_tokens() {
        let text = loop_schedule_instruction("every 30 minutes do x");
        assert!(text.contains("every 30 minutes do x"));
        assert!(text.contains("<number><unit>"));
        assert!(!text.contains("10m"), "no host-side default interval");
        assert!(
            !text.contains("recurring:"),
            "the retired one-shot flag must not be referenced"
        );
        assert!(
            text.contains("task_id"),
            "must teach in-place updates via task_id"
        );
        assert!(
            text.contains("scheduler_delete <task_id>"),
            "the fire must be authorized to end the task"
        );
        assert!(
            text.contains("detached background subagent"),
            "every fire is detached, and the stored prompt must be told so"
        );
    }

    #[test]
    fn goal_instruction_carries_objective_and_contract_tokens() {
        let text = goal_instruction("ship the widget");
        assert!(text.contains("ship the widget"));
        assert!(text.contains("update_goal(completed: true"));
        assert!(text.contains("blocked_reason"));
        assert!(
            !text.contains("system-reminder"),
            "expansions ride as user messages and must not claim reminder authority"
        );
        assert!(goal_usage_message().contains("Usage: /goal"));
        assert!(!text.contains("test each change"));
        assert!(text.contains("background"));
        assert!(text.contains("evidence produced in this session"));
    }

    #[test]
    fn usage_message_has_no_default_claim() {
        assert!(loop_usage_message().contains("Usage: /loop"));
        assert!(!loop_usage_message().contains("10m"));
    }
}
