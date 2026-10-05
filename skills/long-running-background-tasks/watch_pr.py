#!/usr/bin/env python3
"""Watch one GitHub PR. Print JSON events. Exit on merge or close."""

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse

REVIEW_THREADS_QUERY = """
query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $endCursor) {
        nodes {
          id
          isResolved
          comments(last: 100) {
            nodes {
              author { __typename login }
              body
              path
              line
              url
              commit { oid }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
""".strip()


def parse_pr(value: str) -> Tuple[str, int, Optional[str]]:
    """Return (owner/repo, number, host). host is the URL netloc, including
    github.com. OWNER/REPO#NUMBER leaves host None so gh uses GH_HOST / config."""
    parsed = urlparse(value)
    if parsed.scheme:
        parts = [p for p in parsed.path.split("/") if p]
        if not parsed.netloc or len(parts) != 4 or parts[2] != "pull":
            raise ValueError("use https://HOST/OWNER/REPO/pull/NUMBER")
        host = parsed.netloc.lower()
        # Always return a host for URLs so a leftover enterprise GH_HOST cannot
        # steal github.com polls. OWNER/REPO#NUMBER still returns None.
        return f"{parts[0]}/{parts[1]}", int(parts[3]), host
    repo, number = value.rsplit("#", 1)
    return repo, int(number), None


def login_of(user: object) -> Optional[str]:
    return user.get("login") if isinstance(user, dict) else None


def comment_kind(author: Optional[str], typename: Optional[str]) -> str:
    if typename == "Bot" or (author and author.lower().endswith("[bot]")):
        return "bugbot_comment"
    return "human_review_comment"


@dataclass(frozen=True)
class Gh:
    """Runs the gh CLI and decodes its stdout."""

    host: Optional[str] = None

    def run(self, *args: str) -> str:
        # GH_HOST points both `gh api` and `gh pr view` at a GitHub Enterprise
        # instance. When the PR URL named a host, always set it so a leftover
        # enterprise GH_HOST cannot redirect a github.com watch.
        env = {**os.environ, "GH_HOST": self.host} if self.host else None
        result = subprocess.run(["gh", *args], capture_output=True, text=True, env=env)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "gh failed")
        return result.stdout

    def json(self, *args: str) -> Dict:
        return json.loads(self.run(*args))

    def lines(self, *args: str) -> List[Dict]:
        return [json.loads(line) for line in self.run(*args).splitlines() if line]


@dataclass(frozen=True)
class PullRequestApi:
    """The GitHub endpoints this watcher reads, scoped to one pull request."""

    repo: str
    number: int
    gh: Gh = field(default_factory=Gh)
    fetched_commit_comments: Dict[str, List[Dict]] = field(default_factory=dict)
    _commit_refresh: List[int] = field(default_factory=lambda: [0])

    def items(self, path: str, jq: str = ".[]") -> List[Dict]:
        return self.gh.lines("api", "--paginate", path, "--jq", jq)

    def pull(self) -> Dict:
        return self.gh.json("api", f"repos/{self.repo}/pulls/{self.number}")

    def review_decision(self) -> Optional[str]:
        data = self.gh.json(
            "pr", "view", str(self.number), "--repo", self.repo, "--json", "reviewDecision"
        )
        value = data.get("reviewDecision")
        return value if isinstance(value, str) and value else None

    def check_runs(self, sha: str) -> List[Dict]:
        path = f"repos/{self.repo}/commits/{sha}/check-runs?per_page=100"
        return self.items(path, ".check_runs[]")

    def statuses(self, sha: str) -> List[Dict]:
        return self.items(f"repos/{self.repo}/commits/{sha}/statuses?per_page=100")

    def pull_commits(self) -> List[Dict]:
        return self.items(f"repos/{self.repo}/pulls/{self.number}/commits?per_page=100")

    def commit_comments(self, sha: str) -> List[Dict]:
        return self.items(f"repos/{self.repo}/commits/{sha}/comments?per_page=100")

    def commit_comment_items(self, head_sha: str) -> List[Dict]:
        # Always return comments for every commit so seen keys stay live.
        # Refetch the head every poll; refetch one older SHA per poll so a
        # new comment on an earlier commit still appears without N API
        # calls every tick.
        shas: List[str] = []
        for commit in self.pull_commits():
            sha = commit.get("sha")
            if isinstance(sha, str) and sha:
                shas.append(sha)
        extras = [sha for sha in shas if sha != head_sha]
        rotate = extras[self._commit_refresh[0] % len(extras)] if extras else None
        if extras:
            self._commit_refresh[0] += 1
        items: List[Dict] = []
        for sha in shas:
            refresh = sha == head_sha or sha not in self.fetched_commit_comments or sha == rotate
            if refresh:
                self.fetched_commit_comments[sha] = self.commit_comments(sha)
            items.extend(self.fetched_commit_comments[sha])
        return items

    def reviews(self) -> List[Dict]:
        return self.items(f"repos/{self.repo}/pulls/{self.number}/reviews?per_page=100")

    def issue_comments(self) -> List[Dict]:
        return self.items(f"repos/{self.repo}/issues/{self.number}/comments?per_page=100")

    def review_threads(self) -> List[Dict]:
        owner, name = self.repo.split("/", 1)
        return self.gh.lines(
            "api",
            "graphql",
            "--paginate",
            "-f",
            f"query={REVIEW_THREADS_QUERY}",
            "-f",
            f"owner={owner}",
            "-f",
            f"repo={name}",
            "-F",
            f"number={self.number}",
            "--jq",
            ".data.repository.pullRequest.reviewThreads.nodes[]",
        )


@dataclass
class Event:
    kind: str
    head_sha: str
    terminal: bool = False

    def as_dict(self) -> Dict:
        return asdict(self)

    @classmethod
    def final(cls, pr: Dict, head_sha: str) -> "Event":
        return cls("merged" if pr.get("merged") else "closed", head_sha, terminal=True)

    @classmethod
    def merge_conflict(cls, head_sha: str) -> "Event":
        return cls("merge_conflict", head_sha)

    @classmethod
    def mergeable_now(cls, head_sha: str) -> "Event":
        return cls("mergeable", head_sha)


@dataclass
class CiFailure(Event):
    name: Optional[str] = None
    conclusion: Optional[str] = None

    @classmethod
    def from_check(cls, head_sha: str, check: Dict) -> "CiFailure":
        return cls(
            "ci_failure",
            head_sha,
            name=check.get("name"),
            conclusion=check.get("conclusion"),
        )


@dataclass
class Comment(Event):
    author: Optional[str] = None
    body: str = ""
    url: Optional[str] = None

    @classmethod
    def from_rest_item(cls, head_sha: str, item: Dict) -> Optional["Comment"]:
        body = (item.get("body") or "").strip()
        if not body:
            return None
        user = item.get("user") or {}
        author = login_of(user)
        return cls(
            comment_kind(author, user.get("type")),
            head_sha,
            author=author,
            body=body,
            url=item.get("html_url"),
        )


@dataclass
class ThreadComment(Comment):
    path: Optional[str] = None
    line: Optional[int] = None
    thread_id: Optional[str] = None
    commit_oid: Optional[str] = None

    @staticmethod
    def pick_comment(nodes: List[Dict], pr_author: Optional[str]) -> Optional[Dict]:
        nonempty = [node for node in nodes if (node.get("body") or "").strip()]
        if not nonempty:
            return None
        outsiders = [node for node in nonempty if login_of(node.get("author")) != pr_author]
        # A self-only thread is not a wakeup: the author (or this watcher)
        # talking to themselves is not review.
        return outsiders[-1] if outsiders else None

    @classmethod
    def from_thread(
        cls, head_sha: str, thread: Dict, pr_author: Optional[str]
    ) -> Optional["ThreadComment"]:
        if thread.get("isResolved"):
            return None
        comment = cls.pick_comment(thread.get("comments", {}).get("nodes") or [], pr_author)
        if comment is None:
            return None
        author_info = comment.get("author") if isinstance(comment.get("author"), dict) else {}
        commit = comment.get("commit") if isinstance(comment.get("commit"), dict) else {}
        author = login_of(author_info)
        return cls(
            comment_kind(author, author_info.get("__typename")),
            head_sha,
            author=author,
            body=comment["body"].strip(),
            url=comment.get("url"),
            path=comment.get("path"),
            line=comment.get("line"),
            thread_id=thread.get("id"),
            commit_oid=commit.get("oid"),
        )


def event_time(item: Dict, *keys: str) -> str:
    """First present timestamp so we can keep the newest check or status."""
    for key in keys:
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def latest_statuses(statuses: List[Dict]) -> List[Dict]:
    latest: Dict[str, Dict] = {}
    for status in statuses:
        context = status.get("context")
        if not isinstance(context, str) or not context:
            continue
        current = latest.get(context)
        if current is None or event_time(status, "updated_at") >= event_time(current, "updated_at"):
            latest[context] = status
    return list(latest.values())


def latest_checks(checks: List[Dict]) -> List[Dict]:
    # Key by check name only. A rerun creates a new check_suite id, so
    # (name, suite_id) would keep the failed suite next to the successful one
    # and `failing` would never clear.
    latest: Dict[str, Dict] = {}
    for check in checks:
        name = check.get("name")
        if not isinstance(name, str) or not name:
            continue
        current = latest.get(name)
        if current is None or event_time(check, "completed_at", "started_at") >= event_time(
            current, "completed_at", "started_at"
        ):
            latest[name] = check
    return list(latest.values())


def events(api: PullRequestApi) -> Tuple[List[Dict], Optional[bool]]:
    pr = api.pull()
    sha = pr["head"]["sha"]
    raw_mergeable = pr.get("mergeable")
    mergeable = raw_mergeable if isinstance(raw_mergeable, bool) else None
    if pr["state"] != "open":
        return [Event.final(pr, sha).as_dict()], mergeable

    found: List[Event] = []
    if mergeable is False:
        found.append(Event.merge_conflict(sha))

    failing = False
    pending = False
    for check in latest_checks(api.check_runs(sha)):
        if check.get("head_sha") and check["head_sha"] != sha:
            continue
        if check.get("conclusion") in _FAILURE_CONCLUSIONS:
            failing = True
            found.append(CiFailure.from_check(sha, check))
        elif (check.get("status") or "").lower() in _PENDING_STATUSES:
            pending = True

    for status in latest_statuses(api.statuses(sha)):
        if status.get("sha") and status["sha"] != sha:
            continue
        state = (status.get("state") or "").lower()
        if state in {"failure", "error"}:
            failing = True
            found.append(
                CiFailure(
                    "ci_failure",
                    sha,
                    name=status.get("context"),
                    conclusion=status.get("state"),
                )
            )
        elif state == "pending":
            pending = True

    pr_author = login_of(pr.get("user"))
    seen_bodies: Set[Tuple[Optional[str], str]] = set()
    open_threads = False

    for thread in api.review_threads():
        comment = ThreadComment.from_thread(sha, thread, pr_author)
        if comment is None:
            continue
        open_threads = True
        seen_bodies.add((comment.author, comment.body))
        found.append(comment)

    for review in api.reviews():
        comment = Comment.from_rest_item(sha, review)
        if comment is None or comment.author == pr_author:
            continue
        if (comment.author, comment.body) in seen_bodies:
            continue
        seen_bodies.add((comment.author, comment.body))
        found.append(comment)

    for item in api.issue_comments():
        comment = Comment.from_rest_item(sha, item)
        # Same filter as review bodies: the author's own conversation comments
        # (including replies this watcher just posted) are not wakeups.
        if comment is None or comment.author == pr_author:
            continue
        if (comment.author, comment.body) in seen_bodies:
            continue
        seen_bodies.add((comment.author, comment.body))
        found.append(comment)

    for item in api.commit_comment_items(sha):
        comment = Comment.from_rest_item(sha, item)
        if comment is None or comment.author == pr_author:
            continue
        if (comment.author, comment.body) in seen_bodies:
            continue
        seen_bodies.add((comment.author, comment.body))
        found.append(comment)

    mergeable_state = (pr.get("mergeable_state") or "unknown").lower()
    review = api.review_decision()
    if (
        pr.get("draft") is not True
        and mergeable is True
        and mergeable_state in _READY_MERGEABLE_STATES
        and not failing
        and not pending
        and not open_threads
        and review not in _BLOCKING_REVIEW_DECISIONS
    ):
        found.append(Event.mergeable_now(sha))

    return [event.as_dict() for event in found], mergeable


_FAILURE_CONCLUSIONS = frozenset(
    {"failure", "error", "timed_out", "startup_failure", "action_required"}
)
_PENDING_STATUSES = frozenset({"queued", "in_progress", "pending", "waiting", "requested"})
_READY_MERGEABLE_STATES = frozenset({"clean", "has_hooks"})
_BLOCKING_REVIEW_DECISIONS = frozenset({"CHANGES_REQUESTED", "REVIEW_REQUIRED"})
_COMMENT_KINDS = frozenset({"human_review_comment", "bugbot_comment"})
# Identity is author+body so a review summary is not a new event after the
# matching unresolved thread disappears (url and thread_id would differ).
_COMMENT_KEY_FIELDS = ("kind", "author", "body")


def event_key(event: Dict) -> str:
    kind = event.get("kind")
    if kind in _COMMENT_KINDS:
        return json.dumps(
            {field: event.get(field) for field in _COMMENT_KEY_FIELDS}, sort_keys=True
        )
    if kind in {"merge_conflict", "mergeable"}:
        return kind
    return json.dumps(event, sort_keys=True)


_EVENT_FIELD_ORDER = (
    "kind",
    "terminal",
    "head_sha",
    "name",
    "conclusion",
    "url",
    "thread_id",
    "path",
    "line",
    "author",
    "commit_oid",
    "body",
)
_LINE_LIMIT = 500


def _fit_json_line(payload: Dict, shrink_key: str) -> str:
    """Shrink `shrink_key` until the JSON line fits `_LINE_LIMIT`, then drop it.

    Never leave a leftover ellipsis as the only remaining value: that is still
    non-empty, so a naive `while value:` loop never exits when metadata alone
    already exceeds the limit.
    """
    line = json.dumps(payload, separators=(",", ":"))
    while len(line.encode()) > _LINE_LIMIT:
        value = payload.get(shrink_key)
        if not isinstance(value, str) or not value:
            payload.pop(shrink_key, None)
            return json.dumps(payload, separators=(",", ":"))
        trimmed = value[:-8]
        payload[shrink_key] = f"{trimmed.rstrip('…')}…" if trimmed else ""
        if not payload[shrink_key]:
            payload.pop(shrink_key)
        line = json.dumps(payload, separators=(",", ":"))
    return line


def emit(event: Dict) -> None:
    payload: Dict = {"type": "pr_monitor_event"}
    for key in _EVENT_FIELD_ORDER:
        if key == "body" or key not in event:
            continue
        payload[key] = event[key]
    if isinstance(event.get("body"), str):
        payload["body"] = event["body"]
        line = _fit_json_line(payload, "body")
    else:
        line = json.dumps(payload, separators=(",", ":"))
    print(line, flush=True)


def watch(
    api: PullRequestApi,
    poll_interval: float,
    *,
    sleep=time.sleep,
    events_fn=events,
) -> int:
    seen: Set[str] = set()
    seen_errors: Set[str] = set()
    seen_comments: Set[str] = set()
    first_poll = True
    while True:
        try:
            found, mergeable = events_fn(api)
        except (RuntimeError, json.JSONDecodeError, KeyError) as error:
            message = str(error)
            if "API rate limit exceeded" in message:
                message = "API rate limit exceeded"
            elif "error connecting to api.github.com" in message:
                message = "error connecting to api.github.com"
            if message not in seen_errors:
                seen_errors.add(message)
                print(_fit_json_line({"type": "error", "message": message}, "message"), flush=True)
            sleep(poll_interval)
            continue
        seen_errors.clear()
        active = set()
        for event in found:
            key = event_key(event)
            active.add(key)
            if event.get("kind") in _COMMENT_KINDS:
                seen_comments.add(key)
            if key in seen:
                continue
            seen.add(key)
            if first_poll and event.get("kind") in _COMMENT_KINDS:
                continue
            emit(event)
            if event.get("terminal"):
                return 0
        if mergeable is None:
            # GitHub reports null while it recomputes after a push. Keep both
            # merge keys so a later true does not re-emit kind: mergeable.
            active.update(seen & {"merge_conflict", "mergeable"})
        # Comment keys stay even if this poll did not re-fetch an older commit.
        active.update(seen_comments)
        seen.intersection_update(active)
        first_poll = False
        sleep(poll_interval)


def main() -> int:
    parser = argparse.ArgumentParser(description="Watch one PR until it merges or closes.")
    parser.add_argument("pr", help="GitHub or GitHub Enterprise URL, or OWNER/REPO#NUMBER")
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=30.0,
        help="Seconds between GitHub polls (default 30). Lower values hit rate limits.",
    )
    args = parser.parse_args()
    repo, number, host = parse_pr(args.pr)
    return watch(PullRequestApi(repo, number, Gh(host)), args.poll_interval)


if __name__ == "__main__":
    sys.exit(main())
