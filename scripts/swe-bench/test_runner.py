#!/usr/bin/env python3
"""Offline integration checks for the shared agent/grader task pool."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for relative in ('scripts/swe-bench/run.sh', 'scripts/swe-bench/suite.py',
                         'scripts/swe-bench/levels.json', 'scripts/evaluate/summarize.py'):
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, target)
        self.write('scripts/evaluate/model.sh', '''
            ensure_model() { WIRE=$MODEL; }
            model_context_window() { echo 4096; }
            model_parallel_slots() { echo 3; }
        ''')
        self.write('scripts/evaluate/agent.sh', '''
            run_agent() {
              "$SWE_PYTHON" - "$RUN_DIR/$1" <<'PY'
import json, os, sys, time
from pathlib import Path
from fixture import event
directory = Path(sys.argv[1])
job = str(directory)
event('agent-start', job)
time.sleep(0.06)
if os.environ.get('EMPTY_LEVEL') != directory.parent.name.split('-')[0]:
    (directory/'workdir/value.txt').write_text('after\\n')
(directory/'stdout.json').write_text(json.dumps(dict(num_turns=1, tool_calls=1,
    usage=dict(input_tokens=10, output_tokens=5, cache_read_input_tokens=20, cache_creation_input_tokens=0))))
(directory/'elapsed-seconds.txt').write_text('0.06')
(directory/'exit-code.txt').write_text('0')
event('agent-end', job)
PY
            }
        ''')
        self.write('fixture.py', '''
            import fcntl, json, os, time
            def event(kind, job, **extra):
                with open(os.environ['EVENTS'], 'a') as stream:
                    fcntl.flock(stream, fcntl.LOCK_EX)
                    stream.write(json.dumps(dict(kind=kind,job=job,time=time.monotonic(),**extra))+'\\n')
        ''')
        self.write('datasets.py', '''
            import json, os
            from pathlib import Path
            def load_dataset(*args, **kwargs):
                levels = json.loads(Path(os.environ['LEVELS']).read_text())['levels']
                return [dict(instance_id=iid,repo='fixture/repo',base_commit=os.environ['BASE_COMMIT'],
                             problem_statement='Update value.txt.') for ids in levels.values() for iid in ids]
        ''')
        self.write('grader', '''
            #!/usr/bin/env python3
            import json, os, sys, time
            from pathlib import Path
            from fixture import event
            if '--help' in sys.argv:
                sys.exit(0)
            def arg(flag): return sys.argv[sys.argv.index(flag)+1]
            prediction = Path(arg('-p'))
            job = str(prediction.parent)
            row = json.loads(prediction.read_text())
            event('grade-start',job,workers=int(arg('-j')),run_id=arg('--run-id'))
            time.sleep(0.12)
            level = prediction.parent.parent.name.split('-')[0]
            fail = os.environ.get('FAIL_LEVEL') == level
            reportless = os.environ.get('REPORTLESS_LEVEL') == level
            if not fail and not reportless:
                report = Path('logs/run_evaluation',arg('--run-id'),row['model_name_or_path'].replace('/','__'),row['instance_id'])
                report.mkdir(parents=True)
                (report/'report.json').write_text(json.dumps({row['instance_id']:{'resolved':True}}))
            event('grade-end',job)
            sys.exit(1 if fail else 0)
        ''', executable=True)
        source = self.root / 'source'
        source.mkdir()
        def git(*args, cwd=source):
            return subprocess.check_output(['git', *args], cwd=cwd, stderr=subprocess.DEVNULL).decode().strip()
        git('init', '-q')
        (source / 'value.txt').write_text('before\n')
        git('add', '.')
        git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture')
        base = git('rev-parse', 'HEAD')
        mirror = self.root / 'temp/swe-bench/mirrors/fixture__repo.git'
        mirror.parent.mkdir(parents=True)
        git('clone', '--mirror', str(source), str(mirror))
        tasks = self.root / 'tasks'
        tasks.mkdir()
        git('init', '-q', cwd=tasks)
        git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'tasks', cwd=tasks)
        self.env = dict(os.environ, SWE_PYTHON=sys.executable, SWE_BIN=str(self.root/'grader'),
                        SWE_TASK_REPO=str(tasks), PYTHONPATH=str(self.root), BASE_COMMIT=base,
                        LEVELS=str(self.root/'scripts/swe-bench/levels.json'), EVENTS=str(self.root/'events.jsonl'))

    def write(self, relative, content, executable=False):
        path = self.root / relative
        path.write_text(textwrap.dedent(content).lstrip())
        if executable:
            path.chmod(0o755)

    def run_cli(self, *args, **env):
        return subprocess.run(['bash', str(self.root/'scripts/swe-bench/run.sh'), '--model', 'offline/model',
                               '--agents', 'cook', *args], env=dict(self.env, **env),
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)

    def events(self):
        return [json.loads(line) for line in (self.root/'events.jsonl').read_text().splitlines()]

    def bundle(self):
        return next((self.root/'docs/audits').iterdir())

    def test_ten_seeds_share_three_slots_and_grade_immediately(self):
        run = self.run_cli('--parallel','3','--seeds','1,2,3,4,5,6,7,8,9,10','--grade','true')
        self.assertEqual(run.returncode, 0, run.stdout)
        events = self.events()
        active, maximum = set(), 0
        stages = {}
        for event in events:
            job, kind = event['job'], event['kind']
            stages.setdefault(job, []).append(kind)
            if kind=='agent-start':
                active.add(job)
                maximum = max(maximum, len(active))
                self.assertLessEqual(len(active), 3, events)
            elif kind=='grade-start':
                self.assertIn(job, active)
                self.assertEqual(event['workers'], 1)
            elif kind=='grade-end':
                active.remove(job)
        self.assertEqual(maximum, 3)
        self.assertFalse(active)
        self.assertEqual(len(stages), 40)
        for kinds in stages.values():
            self.assertEqual(kinds, ['agent-start','agent-end','grade-start','grade-end'])
        ids = [e['run_id'] for e in events if e['kind']=='grade-start']
        self.assertEqual(len(ids), len(set(ids)))
        first_seed2 = min(e['time'] for e in events if e['kind']=='agent-start' and '/seed-2/' in e['job'])
        last_seed1 = max(e['time'] for e in events if e['kind']=='grade-end' and '/seed-1/' in e['job'])
        self.assertLess(first_seed2, last_seed1, 'pool must cross seed boundaries')
        status = json.loads((self.bundle()/'run-status.json').read_text())
        self.assertEqual(status['summary']['resolved'], 40)
        self.assertEqual(status['summary']['grade_errors'], 0)
        self.assertEqual(sum(t['input'] for t in status['tasks'].values()), 400)
        self.assertIn('| cook | 40/40 |', (self.bundle()/'report.md').read_text())
        self.assertEqual(len(list(self.bundle().glob('seed-*/report.md'))), 10)
        # Seed reports land as each seed finishes, while later tasks still run.
        self.assertRegex(run.stdout, r'Reporting seed \d+')
        self.assertLess(run.stdout.index('Reporting seed'), run.stdout.rindex('Agent finished'))

    def test_single_seed_and_no_grade_remain_supported(self):
        run = self.run_cli('--seed','1','--grade','false')
        self.assertEqual(run.returncode, 0, run.stdout)
        self.assertFalse(any(e['kind'].startswith('grade') for e in self.events()))
        self.assertIn('not graded', (self.bundle()/'report.md').read_text())
        self.assertTrue((self.bundle()/'selection.json').exists())

    def test_empty_patch_and_grade_failure_do_not_stall_queue(self):
        run = self.run_cli('--seeds','1-2','--grade','true', EMPTY_LEVEL='easy', FAIL_LEVEL='hard')
        self.assertEqual(run.returncode, 1, run.stdout)
        status = json.loads((self.bundle()/'run-status.json').read_text())
        self.assertEqual(status['summary']['attempted'], 8)
        self.assertEqual(status['summary']['resolved'], 4)
        self.assertEqual(status['summary']['grade_errors'], 2)
        self.assertEqual(status['summary']['runner_failures'], 2)
        self.assertEqual(sum(t['label']=='empty' for t in status['tasks'].values()), 2)
        self.assertEqual(sum(e['kind']=='grade-start' for e in self.events()), 6)

    def test_agents_share_slots_and_missing_grade_result_fails(self):
        run = self.run_cli('--seed','1','--agents','cook,pi','--grade','true', REPORTLESS_LEVEL='easy')
        self.assertEqual(run.returncode, 1, run.stdout)
        events = self.events()
        active, maximum = set(), 0
        for event in events:
            if event['kind']=='agent-start':
                active.add(event['job'])
                maximum = max(maximum, len(active))
            elif event['kind']=='grade-end':
                active.remove(event['job'])
        self.assertEqual(maximum, 3)
        self.assertFalse(active)
        self.assertEqual(sum(e['kind']=='grade-start' for e in events), 8)
        report = (self.bundle()/'report.md').read_text()
        self.assertIn('error', report)
        self.assertIn('resolved', report)

    def test_seed_and_grade_validation_and_dry_run(self):
        for args in [('--seeds',''),('--seeds','1,,2'),('--seeds','2-1'),('--seeds','1,01'),
                     ('--seeds','a'),('--seed','1','--seeds','2'),('--grade','yes'),('--parallel','4')]:
            with self.subTest(args=args):
                self.assertEqual(self.run_cli(*args,'--dry-run').returncode, 2)
        csv = self.run_cli('--seeds','1,2,3','--grade','true','--dry-run')
        ranged = self.run_cli('--seeds','1-3','--dry-run')
        self.assertEqual(csv.returncode, 0, csv.stdout)
        self.assertEqual(csv.stdout, ranged.stdout)
        self.assertEqual(len([line for line in csv.stdout.splitlines() if '\t' in line]), 12)
        self.assertFalse((self.root/'events.jsonl').exists())


if __name__=='__main__':
    unittest.main()
