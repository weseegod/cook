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


def sample(data, seed):
    rng = random.Random(seed)
    return dict(dataset=data['dataset'], revision=data['revision'], seed=seed,
                instances=[dict(level=k, instance_id=rng.choice(data['levels'][k])) for k in LEVELS])


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


def render_report(bundle, agents, model, no_grade):
    spec = importlib.util.spec_from_file_location('evaluation_usage', Path(__file__).parents[1] / 'evaluate/summarize.py')
    usage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(usage)
    selection = json.loads((bundle / 'selection.json').read_text())
    runs = json.loads((bundle / 'grading.json').read_text()) if (bundle / 'grading.json').exists() else {}
    lines = [f'# SWE-bench evaluation: {model}', '', f"Seed: {selection['seed']}; dataset: {selection['dataset']}; revision: {selection['revision']}", '', '| Level / instance | ' + ' | '.join(agents) + ' |', '| --- | ' + ' | '.join('---' for _ in agents) + ' |']
    for row in selection['instances']:
        iid, level = row['instance_id'], row['level']
        cells = []
        for agent in agents:
            directory = bundle / f'{level}-{iid}' / agent
            patch = (directory / 'patch.diff').read_text() if (directory / 'patch.diff').exists() else None
            exit_code = (directory / 'exit-code.txt').read_text().strip() if (directory / 'exit-code.txt').exists() else 'missing'
            metrics = getattr(usage, 'usage_' + ('cook' if agent == 'cook-main' else agent))(directory / 'stdout.json')
            run = runs.get(agent, {})
            report_dir = bundle / 'logs/evaluation' / run.get('run_id', '') / run.get('model_name_or_path', '').replace('/', '__') / iid
            label = 'error' if patch is None else grade_label(patch, report_dir, iid, no_grade)
            tokens = ', '.join(f'{k}={metrics.get(k) if metrics.get(k) is not None else "?"}' for k in ('calls', 'input', 'output', 'read', 'write', 'tools'))
            budget = (directory / 'timeout-seconds.txt').read_text().strip() if (directory / 'timeout-seconds.txt').exists() else '?'
            elapsed = (directory / 'elapsed-seconds.txt').read_text().strip() if (directory / 'elapsed-seconds.txt').exists() else '?'
            cells.append(f'exit {exit_code}; elapsed {elapsed}s / limit {budget}s<br>{tokens}<br>{len(patch.encode()) if patch is not None else "?"} bytes; {label}')
        lines.append(f'| {level} / {iid} | ' + ' | '.join(cells) + ' |')
    lines += ['', 'Patches, prompts, exit codes, and raw agent outputs are retained in this bundle.', '']
    (bundle / 'report.md').write_text('\n'.join(lines))
    print(bundle / 'report.md')


def self_test():
    rows = [dict(instance_id=f'org__repo-{i}', patch=('diff --git a/x b/x\n' * (i//2+1))) for i in range(8)]
    data = build_levels(rows, 'a'*40)
    assert [len(data['levels'][k]) for k in LEVELS] == [2]*4
    assert [data['levels'][k] for k in LEVELS] == [[f'org__repo-{i}' for i in range(j,j+2)] for j in range(0,8,2)]
    assert sample(data, 1) == sample(data, 1)
    assert len({r['instance_id'] for r in sample(data, 1)['instances']}) == 4
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
    p = sub.add_parser('report')
    p.add_argument('--bundle', type=Path, required=True)
    p.add_argument('--agents', required=True)
    p.add_argument('--model', required=True)
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
        selection = sample(read_levels(a.levels), a.seed)
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
            with (a.bundle / 'predictions' / f'{agent}.jsonl').open('w') as f:
                for row in selection['instances']:
                    path = a.bundle / f"{row['level']}-{row['instance_id']}" / agent / 'patch.diff'
                    patch = path.read_text() if path.exists() else ''
                    f.write(json.dumps(dict(instance_id=row['instance_id'], model_name_or_path=name, model_patch=patch)) + '\n')
        (a.bundle / 'grading.json').write_text(json.dumps(runs, indent=2) + '\n')
    elif a.command == 'report':
        render_report(a.bundle, a.agents.split(','), a.model, a.no_grade)
    else:
        parser.error('choose a command or --self-test')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, StopIteration) as exc:
        print(f'suite: {exc}', file=sys.stderr)
        raise SystemExit(2)
