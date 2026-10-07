#!/usr/bin/env python3
"""Pinned four-instance SWE-bench selection, checkout, patches, and reports."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import random
import re
import subprocess
import sys
import tempfile

DATASET = 'SWE-bench/SWE-bench_Verified'
LEVELS = ('easy', 'medium', 'hard', 'very-hard')
DEFAULT_LEVELS = Path(__file__).with_name('levels.json')
SUFFIX = '\n\nWork only in the current directory. Modify the code to resolve the issue. Do not ask questions.\n'


def load_verified(revision):
    try:
        from datasets import load_dataset
    except ImportError:
        print('Install dependency: pip install datasets', file=sys.stderr)
        raise SystemExit(2)
    return load_dataset(DATASET, revision=revision, split='test')


def build_levels(rows, revision):
    ordered = sorted(rows, key=lambda r: (sum(line.startswith('diff --git ') for line in r['patch'].splitlines()), len(r['patch']), r['instance_id']))
    return dict(dataset=DATASET, revision=revision, levels={level: [r['instance_id'] for r in ordered[len(ordered)*i//4:len(ordered)*(i+1)//4]] for i, level in enumerate(LEVELS)})


def read_levels(path):
    data = json.loads(Path(path).read_text())
    if data.get('dataset') != DATASET or not re.fullmatch(r'[0-9a-f]{40}', data.get('revision', '')):
        raise ValueError('levels must pin Verified to a Hugging Face commit SHA')
    levels = data.get('levels', {})
    if set(levels) != set(LEVELS) or any(not isinstance(levels[k], list) or not levels[k] for k in LEVELS):
        raise ValueError('expected four nonempty level lists')
    ids = [iid for level in LEVELS for iid in levels[level]]
    if any(not isinstance(iid, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+-\d+', iid) for iid in ids) or len(ids) != len(set(ids)):
        raise ValueError('invalid or duplicate instance id')
    return data


def parse_only_levels(text):
    """Comma-separated subset of LEVELS; order follows LEVELS, not the input."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError('levels must be a non-empty comma-separated list')
    wanted = []
    seen = set()
    for item in text.split(','):
        level = item.strip()
        if not level:
            raise ValueError('levels list has an empty entry')
        if level not in LEVELS:
            raise ValueError(f'invalid level: {level}; expected one of {", ".join(LEVELS)}')
        if level in seen:
            raise ValueError(f'duplicate level: {level}')
        seen.add(level)
        wanted.append(level)
    return tuple(level for level in LEVELS if level in seen)


def sample(data, seed, only_levels=None):
    rng = random.Random(seed)
    # Always draw one ID per LEVELS entry so subsetting keeps the same
    # easy/medium/... picks as a full four-level sample for that seed.
    drawn = [dict(level=k, instance_id=rng.choice(data['levels'][k])) for k in LEVELS]
    levels = only_levels or LEVELS
    wanted = set(levels)
    return dict(dataset=data['dataset'], revision=data['revision'], seed=seed,
                levels=list(levels),
                instances=[row for row in drawn if row['level'] in wanted])


def git(*args, cwd=None):
    return subprocess.check_output(['git', *map(str, args)], cwd=cwd)


def checkout(repo, commit, destination, mirrors, source=None):
    destination = Path(destination)
    if destination.exists():
        raise ValueError(f'checkout destination already exists: {destination}')
    if source is None:
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
            raise ValueError('invalid repository')
        source = Path(mirrors) / (repo.replace('/', '__') + '.git')
        source.parent.mkdir(parents=True, exist_ok=True)
        if not source.exists():
            git('clone', '--mirror', f'https://github.com/{repo}.git', source)
        try:
            git('cat-file', '-e', f'{commit}^{{commit}}', cwd=source)
        except subprocess.CalledProcessError:
            git('fetch', 'origin', cwd=source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    git('clone', '--local', '--no-checkout', Path(source).resolve(), destination)
    git('checkout', '--detach', commit, cwd=destination)


def collect_patch(workdir):
    git('add', '-A', cwd=workdir)
    # Compare to the original base even if an agent committed its changes.
    base_file = Path(workdir).parent / 'base-commit.txt'
    base = [base_file.read_text().strip()] if base_file.exists() else []
    return git('diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', *base, '--', cwd=workdir).decode()


def build_prompt(statement):
    return statement.rstrip() + SUFFIX


def grade_label(patch, report_dir, iid, no_grade):
    if not patch:
        return 'empty'
    if no_grade:
        return 'not graded'
    try:
        resolved = json.loads((report_dir / 'report.json').read_text())[iid]['resolved']
        if not isinstance(resolved, bool):
            return 'error'
        if resolved:
            return 'resolved'
        logs = '\n'.join(p.read_text(errors='replace') for p in report_dir.glob('*.log'))
        return 'unresolved (apply failed)' if '>>>>> Patch Apply Failed' in logs or 'APPLY_PATCH_FAIL' in logs else 'unresolved'
    except (OSError, ValueError, KeyError, TypeError):
        return 'error'


def grading_report_dir(bundle, run, iid):
    run = run.get('instances', {}).get(iid, run)
    relative = Path(run.get('run_id', '')) / run.get('model_name_or_path', '').replace('/', '__') / iid
    candidates = [bundle / 'logs/run_evaluation' / relative,
                  bundle / 'logs/evaluation' / relative]
    return next((path for path in candidates if path.exists()), candidates[0])


def load_summarizer():
    spec = importlib.util.spec_from_file_location('evaluation_usage', Path(__file__).parents[1] / 'evaluate/summarize.py')
    usage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(usage)
    return usage


def patch_paths(workdir, base_commit):
    output = git('diff', '--cached', '--name-only', '-z', base_commit, '--', cwd=workdir)
    return sorted(Path(os.fsdecode(raw)) for raw in output.split(b'\0') if raw)


def patch_file_stats(workdir, paths):
    files = 0
    size = 0
    changed = []
    for path in paths:
        full_path = Path(workdir) / path
        files += 1
        if full_path.is_file() and not full_path.is_symlink():
            try:
                size += full_path.stat().st_size
            except OSError:
                pass
            if full_path.suffix.lower() in {'.html', '.htm'}:
                changed.append(full_path)
    return files, size, changed


def render_task_report(bundle, row, agents, model, wire, thinking, parallel, no_grade, usage):
    task_dir = bundle / f"{row['level']}-{row['instance_id']}"
    runs = json.loads((bundle / 'grading.json').read_text()) if (bundle / 'grading.json').exists() else {}
    task = row['problem_statement']
    quoted_task = '> ' + task.replace('|', '\\|').replace('\n', '\n> ')
    lines = [f'# Agent comparison: {model}', '', f'Wire model: `{wire}`',
             f'Thinking: `{thinking}`', f'Parallel: `{parallel}`', '',
             f"Level: `{row['level']}`", f"Instance: `{row['instance_id']}`", '',
             'Task:', '', quoted_task, '',
             '| Agent | Wall s | Exit | Model calls | Tool calls | Uncached input | Output | Cache read | Cache write | Cache field | Usage source | Files | Bytes | Output tokens/s | SWE-bench result |',
             '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | --- |']
    summary = {'expected': {}, 'missing': {}, 'references': {}, 'planned': {}}
    for agent in agents:
        directory = task_dir / agent
        metrics = getattr(usage, 'usage_' + ('cook' if agent == 'cook-main' else agent))(directory / 'stdout.json')
        try:
            seconds = float((directory / 'elapsed-seconds.txt').read_text().strip())
        except (OSError, ValueError):
            seconds = None
        try:
            exit_code = int((directory / 'exit-code.txt').read_text().strip())
        except (OSError, ValueError):
            exit_code = None
        patch_file = directory / 'patch.diff'
        patch = patch_file.read_text(errors='replace') if patch_file.is_file() else None
        if patch is None:
            paths = []
            files, size, changed_html = 0, 0, []
        else:
            paths = patch_paths(directory / 'workdir', row['base_commit'])
            files, size, changed_html = patch_file_stats(directory / 'workdir', paths)
        rate = round(metrics['output'] / seconds, 2) if metrics['output'] is not None and seconds and seconds > 0 else None
        cache_presence = 'present' if metrics['read'] is not None or metrics['write'] is not None else 'unreported'
        run = runs.get(agent, {})
        report_dir = grading_report_dir(bundle, run, row['instance_id'])
        label = grade_label(patch, report_dir, row['instance_id'], no_grade)
        table_values = [agent, f'{seconds:.2f}' if seconds is not None else 'unreported',
                        exit_code if exit_code is not None else 'unreported',
                        metrics['calls'], metrics['tools'], metrics['input'], metrics['output'],
                        metrics['read'], metrics['write'], cache_presence,
                        metrics.get('source', 'stdout.json'), files, size, rate, label]
        lines.append('| ' + ' | '.join('unreported' if value is None else str(value) for value in table_values) + ' |')

        expected = usage.expected_files(task)
        workdir = directory / 'workdir'
        missing = [name for name in expected if not (workdir / name).is_file()]
        references = usage.missing_local_html_references(workdir, changed_html)
        planned = usage.missing_planned_scripts(directory, workdir)
        summary['expected'][agent] = expected
        summary['missing'][agent] = missing
        summary['references'][agent] = references
        summary['planned'][agent] = planned

    lines += ['', '## Static artifact checks', '',
              'These are non-gating snapshot checks; they do not execute the project or test commands. HTML references are checked in patch-changed files; planned script checks cover workspace-relative paths only.',
              '', '| Agent | Required files | Missing files | Broken local HTML refs | Missing workspace test scripts |',
              '| --- | ---: | --- | --- | --- |']
    for agent in agents:
        expected = summary['expected'][agent]
        values = [agent, len(expected) if expected else 'unspecified',
                  ', '.join(summary['missing'][agent]) or '—',
                  ', '.join(summary['references'][agent]) or '—',
                  ', '.join(summary['planned'][agent]) or '—']
        lines.append('| ' + ' | '.join(str(value).replace('|', '\\|') for value in values) + ' |')
    lines += ['', "Metrics come from each agent's JSON output or the labeled Cook session usage file. `unreported` means the field was absent.",
              'Files counts changed paths in the patch; bytes count the current contents of changed regular files (deleted files contribute zero bytes).',
              'SWE-bench status is `not graded` for smoke runs, `empty` for an empty patch, and otherwise comes from the matching grader report.', '']
    (task_dir / 'report.md').write_text('\n'.join(lines))
    return lines


def render_report(bundle, agents, model, no_grade):
    usage = load_summarizer()
    selection = json.loads((bundle / 'selection.json').read_text())
    config = json.loads((bundle / 'config.json').read_text()) if (bundle / 'config.json').exists() else {}
    wire = config.get('wire', model)
    thinking = config.get('thinking', 'unreported')
    parallel = config.get('parallel', 'unreported')
    lines = [f'# Agent comparison: {model}', '', f'Wire model: `{wire}`', f'Thinking: `{thinking}`',
             f'Parallel: `{parallel}`', '',
             f"Seed: `{selection['seed']}`", f"Dataset: `{selection['dataset']}`", f"Revision: `{selection['revision']}`", '',
             '| Level | Instance | ' + ' | '.join(agents) + ' | Detailed report |',
             '| --- | --- | ' + ' | '.join('---' for _ in agents) + ' | --- |']
    for row in selection['instances']:
        iid, level = row['instance_id'], row['level']
        cells = []
        for agent in agents:
            directory = bundle / f'{level}-{iid}' / agent
            patch = (directory / 'patch.diff').read_text(errors='replace') if (directory / 'patch.diff').is_file() else None
            exit_code = (directory / 'exit-code.txt').read_text().strip() if (directory / 'exit-code.txt').is_file() else 'missing'
            budget = (directory / 'timeout-seconds.txt').read_text().strip() if (directory / 'timeout-seconds.txt').is_file() else '?'
            elapsed = (directory / 'elapsed-seconds.txt').read_text().strip() if (directory / 'elapsed-seconds.txt').is_file() else '?'
            runs = json.loads((bundle / 'grading.json').read_text()) if (bundle / 'grading.json').is_file() else {}
            run = runs.get(agent, {})
            report_dir = grading_report_dir(bundle, run, iid)
            result = grade_label(patch, report_dir, iid, no_grade)
            cells.append(f'exit {exit_code}<br>{elapsed}s / {budget}s<br>{len(patch.encode()) if patch is not None else "?"} B<br>{result}')
        render_task_report(bundle, row, agents, model, wire, thinking, parallel, no_grade, usage)
        details = f'[{level} report]({level}-{iid}/report.md)'
        lines.append(f'| {level} | {iid} | ' + ' | '.join(cells) + f' | {details} |')
    lines += ['', 'Each level report includes the full problem statement, per-agent usage and artifact metrics, and static checks.',
              'Patches, prompts, exit codes, and raw agent outputs are retained in this bundle.', '']
    (bundle / 'report.md').write_text('\n'.join(lines))
    print(bundle / 'report.md')


def task_summary(bundle, row, agent, no_grade, usage):
    directory = bundle / f"{row['level']}-{row['instance_id']}" / agent
    def number(filename, convert):
        try:
            return convert((directory / filename).read_text().strip())
        except (OSError, ValueError):
            return None
    path = directory / 'patch.diff'
    patch = path.read_text(errors='replace') if path.exists() else None
    runs = json.loads((bundle / 'grading.json').read_text())
    report_dir = grading_report_dir(bundle, runs.get(agent, {}), row['instance_id'])
    metrics = getattr(usage, 'usage_' + ('cook' if agent == 'cook-main' else agent))(directory / 'stdout.json')
    return dict(seed=json.loads((bundle / 'selection.json').read_text())['seed'],
                level=row['level'], instance_id=row['instance_id'], agent=agent,
                state='complete' if patch is not None and (directory / 'exit-code.txt').exists() else 'failed',
                label=grade_label(patch, report_dir, row['instance_id'], no_grade),
                exit_code=number('exit-code.txt', int), grade_exit_code=number('grade-exit-code.txt', int),
                wall_seconds=number('elapsed-seconds.txt', float), calls=metrics['calls'], tools=metrics['tools'],
                input=metrics['input'], output=metrics['output'], cache_read=metrics['read'], cache_write=metrics['write'])


def render_batch_report(bundle, agents, model, no_grade):
    config = json.loads((bundle / 'config.json').read_text())
    usage = load_summarizer()
    tasks = {}
    seeds = {}
    for seed in config['seeds']:
        directory = bundle / f'seed-{seed}'
        selection = json.loads((directory / 'selection.json').read_text())
        summaries = [task_summary(directory, row, agent, no_grade, usage)
                     for row in selection['instances'] for agent in agents]
        for task in summaries:
            tasks[f"{seed}:{task['level']}:{task['agent']}"] = task
        seeds[str(seed)] = dict(state='complete' if all(t['state']=='complete' for t in summaries) else 'failed',
                                attempted=len(summaries), resolved=sum(t['label']=='resolved' for t in summaries))
    rows = list(tasks.values())
    import datetime
    finished = datetime.datetime.now(datetime.timezone.utc)
    config['finished_at_utc'] = finished.isoformat()
    config['wall_seconds'] = (finished - datetime.datetime.fromisoformat(config['started_at_utc'])).total_seconds()
    summary = dict(attempted=len(rows), resolved=sum(t['label']=='resolved' for t in rows),
                   runner_failures=sum(t['state']=='failed' or t['grade_exit_code'] not in (None, 0) for t in rows),
                   grade_errors=sum(t['label']=='error' for t in rows))
    (bundle / 'run-status.json').write_text(json.dumps(dict(config=config, tasks=tasks, seeds=seeds, summary=summary), indent=2)+'\n')
    lines = [f'# SWE-bench batch: {model}', '', f"Wire model: `{config['wire']}`",
             f"Thinking: `{config['thinking']}`", f"Global parallel pool: `{config['parallel']}` (agent runs and grading share slots)",
             'Seeds: `' + ', '.join(map(str, config['seeds'])) + '`',
             f"Grading: `{'disabled' if no_grade else 'enabled'}`", '',
             f"Resolved: **{summary['resolved']}/{summary['attempted']}** task-agent runs", '',
             '| Agent | Resolved | Task wall s | Model calls | Tool calls | Uncached input | Output | Cache read | Cache write | Reported total tokens |',
             '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
    def total(group, key):
        values = [t[key] for t in group if t[key] is not None]
        return str(sum(values)) + (f' ({len(values)}/{len(group)} reported)' if len(values)!=len(group) else '')
    for agent in agents:
        group = [t for t in rows if t['agent']==agent]
        tokens = sum(t[key] or 0 for t in group for key in ('input','output','cache_read','cache_write'))
        fields = [agent, f"{sum(t['label']=='resolved' for t in group)}/{len(group)}",
                  f"{sum(t['wall_seconds'] or 0 for t in group):.2f}"]
        fields += [total(group, key) for key in ('calls','tools','input','output','cache_read','cache_write')]
        fields.append(str(tokens))
        lines.append('| ' + ' | '.join(fields) + ' |')
    lines += ['', 'Total tokens sums available uncached input, output, cache read, and cache write; missing fields make it a lower bound.',
              'Task wall time is summed across tasks, not elapsed batch time.', '',
              '| Seed | Level | Instance | Agent | Result | Wall s | Exit | Model calls | Tool calls | Uncached input | Output | Cache read | Detail |',
              '| ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |']
    for task in rows:
        values = [task[k] for k in ('seed','level','instance_id','agent','label','wall_seconds','exit_code','calls','tools','input','output','cache_read')]
        link = f"seed-{task['seed']}/{task['level']}-{task['instance_id']}/report.md"
        values.append(f'[task report]({link})')
        lines.append('| ' + ' | '.join('unreported' if v is None else str(v) for v in values) + ' |')
    lines += ['', 'Each seed has a comparison report; each task report contains the full request, usage metrics, and artifact checks.',
              'Per-task grader logs, predictions, patches, agent output, and selections remain in this bundle.', '']
    (bundle / 'report.md').write_text('\n'.join(lines))
    print(bundle / 'report.md')


def self_test():
    rows = [dict(instance_id=f'org__repo-{i}', patch=('diff --git a/x b/x\n' * (i//2+1))) for i in range(8)]
    data = build_levels(rows, 'a'*40)
    assert [len(data['levels'][k]) for k in LEVELS] == [2]*4
    assert [data['levels'][k] for k in LEVELS] == [[f'org__repo-{i}' for i in range(j,j+2)] for j in range(0,8,2)]
    assert sample(data, 1) == sample(data, 1)
    assert len({r['instance_id'] for r in sample(data, 1)['instances']}) == 4
    assert sample(data, 1)['levels'] == list(LEVELS)
    subset = sample(data, 1, only_levels=parse_only_levels('medium,easy'))
    assert subset['levels'] == ['easy', 'medium']
    assert [r['level'] for r in subset['instances']] == ['easy', 'medium']
    full = sample(data, 1)
    assert subset['instances'] == [r for r in full['instances'] if r['level'] in ('easy', 'medium')]
    assert parse_only_levels('easy,medium') == ('easy', 'medium')
    assert build_prompt('issue') == 'issue' + SUFFIX
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        source = root / 'source'
        source.mkdir()
        git('init', '-q', cwd=source)
        (source / 'file').write_text('before\n')
        git('add', '-A', cwd=source)
        git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial', cwd=source)
        head = git('rev-parse', 'HEAD', cwd=source).decode().strip()
        work = root / 'agent/workdir'
        checkout('', head, work, root, source)
        assert git('rev-parse', 'HEAD', cwd=work).decode().strip() == head
        assert collect_patch(work) == ''
        (work / 'new.txt').write_text('new\n')
        (work.parent / 'exit-code.txt').write_text('1\n')
        assert 'new file mode' in collect_patch(work)
        (work.parent / 'base-commit.txt').write_text(head)
        git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'agent commit', cwd=work)
        assert 'new.txt' in collect_patch(work)
        iid = 'org__repo-0'
        assert grade_label('', root, iid, False) == 'empty'
        assert grade_label('patch', root, iid, True) == 'not graded'
        assert grade_label('patch', root, iid, False) == 'error'
        for value, expected in [(True, 'resolved'), (False, 'unresolved')]:
            (root / 'report.json').write_text(json.dumps({iid: {'resolved': value}}))
            assert grade_label('patch', root, iid, False) == expected
        run = {'run_id': 'fixture-run', 'model_name_or_path': 'model/agent'}
        actual_report_dir = grading_report_dir(root, run, iid)
        assert actual_report_dir == root / 'logs/run_evaluation/fixture-run/model__agent' / iid
        actual_report_dir.mkdir(parents=True)
        (actual_report_dir / 'report.json').write_text(json.dumps({iid: {'resolved': True}}))
        assert grade_label('patch', actual_report_dir, iid, False) == 'resolved'
        (root / 'run_instance.log').write_text('>>>>> Patch Apply Failed')
        assert grade_label('patch', root, iid, False) == 'unresolved (apply failed)'
        (root / 'report.json').write_text('{broken')
        assert grade_label('patch', root, iid, False) == 'error'
        (root / 'levels.json').write_text(json.dumps(data))
        read_levels(root / 'levels.json')
        # Exercise the actual shared runner: a failed process must still record
        # its exit and leave a patch, while preserving the existing checkout.
        run_dir = root / 'runner'
        runner_work = run_dir / 'pi/workdir'
        checkout('', head, runner_work, root, source)
        fake_pi = root / 'fake-pi'
        fake_pi.write_text('#!/bin/sh\nprintf "created\\n" > created.txt\nexit 1\n')
        fake_pi.chmod(0o755)
        env = dict(os.environ, RUN_DIR=str(run_dir), THINKING='true',
                   WIRE='offline', BASE_URL='http://127.0.0.1:1/v1',
                   CONTEXT_WINDOW='4096', PI_BIN=str(fake_pi), TIMEOUT='5',
                   PROMPT='offline self-test')
        agent_script = Path(__file__).parents[1] / 'evaluate/agent.sh'
        subprocess.run(['bash', '-c', 'set -euo pipefail; source "$1"; run_agent pi',
                        'self-test', str(agent_script)], env=env, check=True)
        assert git('rev-parse', 'HEAD', cwd=runner_work).decode().strip() == head
        assert (runner_work.parent / 'exit-code.txt').read_text().strip() == '1'
        assert 'created.txt' in collect_patch(runner_work)
    if DEFAULT_LEVELS.exists():
        read_levels(DEFAULT_LEVELS)
    print('suite self-test passed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test', action='store_true')
    sub = parser.add_subparsers(dest='command')
    b = sub.add_parser('build-levels')
    b.add_argument('--output', type=Path, default=DEFAULT_LEVELS)
    b.add_argument('--revision')
    s = sub.add_parser('sample')
    s.add_argument('--levels', type=Path, default=DEFAULT_LEVELS)
    s.add_argument('--only', dest='only_levels',
                   help='comma-separated subset of easy,medium,hard,very-hard')
    s.add_argument('--seed', type=int, default=1)
    s.add_argument('--output', type=Path)
    s.add_argument('--hydrate', action='store_true')
    c = sub.add_parser('checkout')
    c.add_argument('--selection', type=Path, required=True)
    c.add_argument('--instance-id', required=True)
    c.add_argument('--destination', required=True)
    c.add_argument('--mirrors', required=True)
    c.add_argument('--source')
    p = sub.add_parser('patch')
    p.add_argument('--workdir', required=True)
    p = sub.add_parser('prompt')
    p.add_argument('--selection', type=Path, required=True)
    p.add_argument('--instance-id', required=True)
    p = sub.add_parser('predictions')
    p.add_argument('--bundle', type=Path, required=True)
    p.add_argument('--agents', required=True)
    p.add_argument('--model', required=True)
    p.add_argument('--stamp', required=True)
    p.add_argument('--per-task', action='store_true')
    for command in ('report', 'batch-report'):
        p = sub.add_parser(command)
        p.add_argument('--bundle', type=Path, required=True)
        p.add_argument('--agents', required=True)
        p.add_argument('--model', required=True)
        p.add_argument('--no-grade', action='store_true')
    p = sub.add_parser('result')
    p.add_argument('--bundle', type=Path, required=True)
    p.add_argument('--agent', required=True)
    p.add_argument('--instance-id', required=True)
    p.add_argument('--no-grade', action='store_true')
    a = parser.parse_args()
    if a.self_test:
        self_test()
    elif a.command == 'build-levels':
        # Check datasets before importing its transitive dependency.
        try:
            import datasets
        except ImportError:
            print('Install dependency: pip install datasets', file=sys.stderr)
            raise SystemExit(2)
        from huggingface_hub import HfApi
        revision = HfApi().dataset_info(DATASET, revision=a.revision).sha
        a.output.write_text(json.dumps(build_levels(load_verified(revision), revision), indent=2) + '\n')
    elif a.command == 'sample':
        only = parse_only_levels(a.only_levels) if a.only_levels else None
        selection = sample(read_levels(a.levels), a.seed, only_levels=only)
        if a.hydrate:
            wanted = {r['instance_id'] for r in selection['instances']}
            rows = {r['instance_id']: {k: r[k] for k in ('instance_id', 'repo', 'base_commit', 'problem_statement')} for r in load_verified(selection['revision']) if r['instance_id'] in wanted}
            for row in selection['instances']:
                row.update(rows[row['instance_id']])
        if a.output:
            a.output.write_text(json.dumps(selection, indent=2) + '\n')
        for row in selection['instances']:
            print(row['level'], row['instance_id'], sep='\t')
    elif a.command in ('checkout', 'prompt'):
        row = next(r for r in json.loads(a.selection.read_text())['instances'] if r['instance_id'] == a.instance_id)
        if a.command == 'prompt':
            print(build_prompt(row['problem_statement']), end='')
        else:
            checkout(row['repo'], row['base_commit'], a.destination, a.mirrors, a.source)
            (Path(a.destination).parent / 'base-commit.txt').write_text(row['base_commit'] + '\n')
    elif a.command == 'patch':
        print(collect_patch(a.workdir), end='')
    elif a.command == 'predictions':
        selection = json.loads((a.bundle / 'selection.json').read_text())
        runs = {}
        (a.bundle / 'predictions').mkdir(exist_ok=True)
        for agent in a.agents.split(','):
            name = a.model + '/' + agent
            runs[agent] = dict(run_id=f'cook-swe-{a.stamp}-{agent}', model_name_or_path=name)
            if a.per_task:
                runs[agent]['instances'] = {row['instance_id']: dict(run_id=f"cook-swe-{a.stamp}-{agent}-{row['instance_id']}",
                                           model_name_or_path=name) for row in selection['instances']}
            with (a.bundle / 'predictions' / f'{agent}.jsonl').open('w') as f:
                for row in selection['instances']:
                    path = a.bundle / f"{row['level']}-{row['instance_id']}" / agent / 'patch.diff'
                    patch = path.read_text() if path.exists() else ''
                    f.write(json.dumps(dict(instance_id=row['instance_id'], model_name_or_path=name, model_patch=patch)) + '\n')
        (a.bundle / 'grading.json').write_text(json.dumps(runs, indent=2) + '\n')
    elif a.command == 'report':
        render_report(a.bundle, a.agents.split(','), a.model, a.no_grade)
    elif a.command == 'batch-report':
        render_batch_report(a.bundle, a.agents.split(','), a.model, a.no_grade)
    elif a.command == 'result':
        selection = json.loads((a.bundle / 'selection.json').read_text())
        row = next(r for r in selection['instances'] if r['instance_id']==a.instance_id)
        task = task_summary(a.bundle, row, a.agent, a.no_grade, load_summarizer())
        print(f"Completed seed {task['seed']}, {task['level']} ({a.agent}): {task['label']}; "
              f"uncached input={task['input']}, output={task['output']}, cache read={task['cache_read']}")
        if task['label']=='error' or task['state']=='failed':
            raise SystemExit(1)
    else:
        parser.error('choose a command or --self-test')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, StopIteration) as exc:
        print(f'suite: {exc}', file=sys.stderr)
        raise SystemExit(2)
