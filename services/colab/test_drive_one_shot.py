"""Deterministic transport/process fault injection, not real Drive or GPU proof."""
import copy
import ast
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from drive_one_shot import run_one_job
from sns_studio_model_adapter import validate_input, canonical_hash, generate_mock_video, validate_video
from build_bundle import build_bundle, FILES

REAL_RUN = subprocess.run


class Conflict(Exception):
    resp = type('Response', (), {'status': 409})()


class FakeDrive:
    def __init__(self, attempt=1):
        input = validate_input({'prompt': 'mug', 'mock': False, 'seed': 0})
        self.job = dict(schemaVersion=2, jobId='test-job', organizationId='test-org', attempt=attempt, input=input, inputHash=canonical_hash(input), jobFolderId=f'job-folder-{attempt}', outputFolderId='root', lockFileId=f'lock-{attempt}', outputFileId=f'output-{attempt}', resultFileId=f'result-{attempt}', controlFileId=f'control-{attempt}')
        self.files = {'manifest': self.job, f'control-{attempt}': dict(jobId='test-job', attempt=attempt, cancelRequested=False)}
        self.upload_fail_once = False
        self.uploads = {}

    def json(self, file_id):
        return copy.deepcopy(self.files[file_id])

    def metadata(self, file_id):
        if file_id == 'manifest':
            return {'parents': [self.job['jobFolderId']]}
        return {'parents': ['root']}

    def create_json(self, file_id, folder, name, value):
        if file_id in self.files:
            raise Conflict()
        self.files[file_id] = copy.deepcopy(value)
        return {'id': file_id}

    def upload_output(self, file_id, folder, path, identity):
        if self.upload_fail_once:
            self.upload_fail_once = False
            raise OSError('Injected partial transport failure')
        self.uploads[file_id] = path.read_bytes()


class TestOneShot(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.fixture = Path(cls.temp.name)/'fixture.mp4'
        generate_mock_video(cls.fixture, duration_seconds=49/16)
        cls.info = validate_video(cls.fixture)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def process(self, cmd, **kwargs):
        if cmd[0] != sys.executable:
            return REAL_RUN(cmd, **kwargs)
        self.inferences += 1
        work = Path(cmd[3])
        job = json.loads(Path(cmd[2]).read_text())
        output = work/'sns_studio_test.mp4'
        shutil.copyfile(self.fixture, output)
        # Fixture evidence exercises import validation only, never GPU success.
        (work/'generation-evidence.json').write_text(json.dumps(dict(mock=False, realInference=True, output=self.info)))
        return subprocess.CompletedProcess(cmd, 0, b'', b'')

    def setUp(self):
        self.inferences = 0

    def test_duplicate_execution_and_result_sync_are_idempotent(self):
        drive = FakeDrive()
        with tempfile.TemporaryDirectory() as out, patch('drive_one_shot.subprocess.run', side_effect=self.process):
            first = run_one_job(drive, 'manifest', 'test-job', 1, Path(out))
            second = run_one_job(drive, 'manifest', 'test-job', 1, Path(out))
            self.assertEqual(first, second)
            self.assertEqual(self.inferences, 1)
            self.assertEqual(len(drive.uploads), 1)

    def test_other_runtime_cannot_execute_the_same_claim(self):
        drive = FakeDrive()
        with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as other, patch('drive_one_shot.subprocess.run', side_effect=self.process):
            run_one_job(drive, 'manifest', 'test-job', 1, Path(out))
            with self.assertRaisesRegex(RuntimeError, 'ALREADY_CLAIMED'):
                run_one_job(drive, 'manifest', 'test-job', 1, Path(other))
            self.assertEqual(self.inferences, 1)

    def test_partial_upload_resumes_completed_output_without_new_inference(self):
        drive = FakeDrive(); drive.upload_fail_once = True
        with tempfile.TemporaryDirectory() as out, patch('drive_one_shot.subprocess.run', side_effect=self.process):
            with self.assertRaises(OSError):
                run_one_job(drive, 'manifest', 'test-job', 1, Path(out))
            self.assertNotIn('result-1', drive.files)
            self.assertEqual(run_one_job(drive, 'manifest', 'test-job', 1, Path(out))['status'], 'COMPLETE')
            self.assertEqual(self.inferences, 1)

    def test_failed_attempt_requires_new_attempt_not_filename_skipping(self):
        drive = FakeDrive()
        def fail(cmd, **kwargs):
            return subprocess.CompletedProcess(cmd, 1, b'', b'') if cmd[0] == sys.executable else REAL_RUN(cmd, **kwargs)
        with tempfile.TemporaryDirectory() as out, patch('drive_one_shot.subprocess.run', side_effect=fail):
            with self.assertRaises(RuntimeError):
                run_one_job(drive, 'manifest', 'test-job', 1, Path(out))
            self.assertEqual(drive.files['result-1']['status'], 'FAILED')
        second = FakeDrive(2)
        with tempfile.TemporaryDirectory() as out, patch('drive_one_shot.subprocess.run', side_effect=self.process):
            self.assertEqual(run_one_job(second, 'manifest', 'test-job', 2, Path(out))['attempt'], 2)

    def test_cancel_before_inference_never_runs_model(self):
        drive = FakeDrive(); drive.files['control-1']['cancelRequested'] = True
        with tempfile.TemporaryDirectory() as out, patch('drive_one_shot.subprocess.run', side_effect=self.process):
            with self.assertRaisesRegex(RuntimeError, 'CANCELLED'):
                run_one_job(drive, 'manifest', 'test-job', 1, Path(out))
            self.assertEqual(self.inferences, 0)
            self.assertFalse(drive.uploads)

    def test_lost_runtime_or_changed_input_does_not_claim_resume(self):
        drive = FakeDrive(); drive.job['input']['prompt'] = 'changed'
        with tempfile.TemporaryDirectory() as out, self.assertRaisesRegex(ValueError, 'MANIFEST_INVALID'):
            run_one_job(drive, 'manifest', 'test-job', 1, Path(out))
        with tempfile.TemporaryDirectory() as out, self.assertRaises(ValueError):
            run_one_job(FakeDrive(), 'manifest', '../escape', 1, Path(out))

    def test_notebook_bundle_and_one_shot_contract(self):
        root = Path(__file__).parent
        notebook = json.loads((root/'sns_studio_worker.ipynb').read_text())
        text = ''.join(''.join(c['source']) for c in notebook['cells'])
        self.assertNotIn('poll_once', text)
        self.assertNotIn('find_job_folders', text)
        self.assertIn('INFERENCE_TIMEOUT_SECONDS = 1800', text)
        self.assertIn(build_bundle(root)[1], text)
        self.assertTrue(all(not cell.get('outputs') for cell in notebook['cells']))

    def test_bundle_hash_survives_windows_checkout_line_endings(self):
        root = Path(__file__).parent
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            for name in FILES:
                (destination/name).write_bytes((root/name).read_bytes().replace(b'\r\n', b'\n').replace(b'\n', b'\r\n'))
            self.assertEqual(build_bundle(root)[1], build_bundle(destination)[1])

    def test_notebook_python_syntax_and_public_source_hashes(self):
        root = Path(__file__).parent
        notebook = json.loads((root/'sns_studio_worker.ipynb').read_text())
        found = False
        for cell in notebook['cells']:
            if cell['cell_type'] != 'code':
                continue
            tree = ast.parse(''.join(cell['source']))
            for node in tree.body:
                if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'EXPECTED_FILE_SHA256' for target in node.targets):
                    found = True
                    hashes = ast.literal_eval(node.value)
                    self.assertEqual(set(hashes), set(FILES))
                    for name, digest in hashes.items():
                        self.assertEqual(hashlib.sha256((root/name).read_bytes().replace(b'\r\n', b'\n')).hexdigest(), digest)
        self.assertTrue(found)


if __name__ == '__main__':
    unittest.main()
