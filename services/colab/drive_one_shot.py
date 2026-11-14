"""One explicit job/attempt. No queue polling, filename lock, or automatic retry."""
from __future__ import annotations
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path
from sns_studio_model_adapter import canonical_hash, validate_input, validate_video, CONTRACT


class DriveTransport:
    def __init__(self, drive):
        self.drive = drive

    def metadata(self, file_id):
        return self.drive.files().get(fileId=file_id, fields='id,name,mimeType,size,parents,trashed,properties').execute()

    def download(self, file_id, max_bytes):
        from googleapiclient.http import MediaIoBaseDownload
        output = io.BytesIO()
        downloader = MediaIoBaseDownload(output, self.drive.files().get_media(fileId=file_id), chunksize=1024*1024)
        done = False
        while not done:
            _, done = downloader.next_chunk(num_retries=0)
            if output.tell() > max_bytes:
                raise ValueError('DRIVE_FILE_TOO_LARGE')
        return output.getvalue()

    def json(self, file_id):
        return json.loads(self.download(file_id, 1024*1024))

    def create_json(self, file_id, folder_id, name, value):
        from googleapiclient.http import MediaIoBaseUpload
        body = json.dumps(value, ensure_ascii=False).encode()
        return self.drive.files().create(body={'id': file_id, 'name': name, 'mimeType': 'application/json', 'parents': [folder_id]}, media_body=MediaIoBaseUpload(io.BytesIO(body), mimetype='application/json'), fields='id').execute()

    def upload_output(self, file_id, folder_id, path, identity):
        from googleapiclient.http import MediaFileUpload
        try:
            return self.drive.files().create(body={'id': file_id, 'name': path.name, 'parents': [folder_id], 'properties': identity}, media_body=MediaFileUpload(str(path), mimetype='video/mp4', resumable=True), fields='id').execute()
        except Exception as error:
            if getattr(getattr(error, 'resp', None), 'status', None) != 409:
                raise
            existing = self.metadata(file_id)
            if existing.get('properties') != identity or int(existing.get('size', 0)) != path.stat().st_size:
                raise RuntimeError('OUTPUT_ID_COLLISION') from None
            return existing


def run_one_job(transport, manifest_file_id: str, expected_job_id: str, expected_attempt: int, work_root: Path, timeout_seconds=1800, python_executable: str | None = None):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', expected_job_id) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', manifest_file_id) or type(expected_attempt) is not int or not 1 <= expected_attempt <= 1000 or not 60 <= timeout_seconds <= 3600:
        raise ValueError('EXECUTION_SETTINGS_INVALID')
    for key in ('MOCK_GENERATION', 'SNS_STUDIO_ALLOW_TEST_MOCK'):
        if os.getenv(key, '').lower() not in ('', '0', 'false'):
            raise RuntimeError('MOCK_ENVIRONMENT_FORBIDDEN')
    job = transport.json(manifest_file_id)
    if job.get('schemaVersion') != 2 or job.get('jobId') != expected_job_id or job.get('attempt') != expected_attempt:
        raise ValueError('JOB_ID_OR_ATTEMPT_MISMATCH')
    input = validate_input(job.get('input'))
    if input['mock'] is not False or job.get('inputHash') != canonical_hash(job['input']):
        raise ValueError('REAL_JOB_MANIFEST_INVALID')
    meta = transport.metadata(manifest_file_id)
    if meta.get('trashed') or job.get('jobFolderId') not in meta.get('parents', []):
        raise ValueError('JOB_FOLDER_MISMATCH')
    folder = transport.metadata(job['jobFolderId'])
    if job.get('outputFolderId') not in folder.get('parents', []) or folder.get('trashed'):
        raise ValueError('JOB_ROOT_MISMATCH')
    # Backend pre-generates this ID; Drive create(id=...) conflicts atomically.
    # The filename is never treated as a lock.
    work = work_root / expected_job_id / f'attempt-{expected_attempt}'
    work.mkdir(parents=True, exist_ok=True)
    identity = dict(jobId=expected_job_id, attempt=expected_attempt, inputHash=job['inputHash'])
    state_path = work / 'runner-state.json'
    state = json.loads(state_path.read_text()) if state_path.exists() else dict(**identity, runId=uuid.uuid4().hex)
    if any(state.get(k) != v for k, v in identity.items()):
        raise ValueError('LOCAL_ATTEMPT_MISMATCH')
    state_path.write_text(json.dumps(state))
    try:
        transport.create_json(job['lockFileId'], job['jobFolderId'], 'execution-lock.json', state)
    except Exception as error:
        if getattr(getattr(error, 'resp', None), 'status', None) != 409:
            raise
        existing = transport.json(job['lockFileId'])
        if existing.get('runId') != state['runId'] or not (work / 'completed-output.json').exists():
            raise RuntimeError('JOB_ALREADY_CLAIMED_RETRY_AS_NEW_ATTEMPT') from None

    def check_cancel():
        control = transport.json(job['controlFileId'])
        if control.get('jobId') != expected_job_id or control.get('attempt') != expected_attempt or control.get('cancelRequested') is not False:
            raise RuntimeError('JOB_CANCELLED_OR_CONTROL_INVALID')

    result_base = dict(schemaVersion=2, organizationId=job['organizationId'], **identity, mock=False)
    checkpoint = work / 'completed-output.json'
    try:
        check_cancel()
        if checkpoint.exists():
            cached = json.loads(checkpoint.read_text())
            output = work / cached['name']
            if validate_video(output)['sha256'] != cached['sha256']:
                raise ValueError('COMPLETED_OUTPUT_HASH_MISMATCH')
        else:
            if state.get('inferenceStarted'):
                raise RuntimeError('INFERENCE_RESTART_REQUIRES_NEW_ATTEMPT')
            if input['mode'] == 'image-to-video':
                ref = input.get('referenceImage', {})
                ref_meta = transport.metadata(ref['fileId'])
                if job['jobFolderId'] not in ref_meta.get('parents', []) or ref_meta.get('mimeType') != ref.get('mimeType') or int(ref_meta.get('size', 0)) != ref.get('sizeBytes'):
                    raise ValueError('REFERENCE_IMAGE_DRIVE_METADATA_INVALID')
                data = transport.download(ref['fileId'], CONTRACT['limits']['imageBytes'])
                if len(data) != ref['sizeBytes'] or hashlib.sha256(data).hexdigest() != ref['sha256']:
                    raise ValueError('REFERENCE_IMAGE_HASH_MISMATCH')
                local_image = work / 'reference-image.bin'
                local_image.write_bytes(data)
                job['localReferenceImage'] = str(local_image.resolve())
            local_manifest = work / 'inference-job.json'
            local_manifest.write_text(json.dumps(job))
            state['inferenceStarted'] = True
            state_path.write_text(json.dumps(state))
            # Finite child process; no paid fallback, unbounded keepalive, or retry.
            completed = subprocess.run([python_executable or sys.executable, str(Path(__file__).with_name('run_inference.py')), str(local_manifest), str(work)], capture_output=True, timeout=timeout_seconds)
            if completed.returncode:
                raise RuntimeError('MODEL_INFERENCE_FAILED_SEE_FAILURE_EVIDENCE')
            outputs = list(work.glob('sns_studio_*.mp4'))
            if len(outputs) != 1:
                raise RuntimeError('OUTPUT_COUNT_INVALID')
            output = outputs[0]
            info = validate_video(output)
            checkpoint.write_text(json.dumps(dict(name=output.name, sha256=info['sha256'])))
        evidence = json.loads((work / 'generation-evidence.json').read_text())
        info = validate_video(output)
        if evidence.get('mock') is not False or evidence.get('realInference') is not True or evidence['output'] != info:
            raise ValueError('EXECUTION_EVIDENCE_INVALID')
        check_cancel()
    except Exception as error:
        # Do not include request URLs, credentials, or arbitrary exception strings.
        code = 'GENERATION_TIMEOUT' if isinstance(error, subprocess.TimeoutExpired) else 'MODEL_ADAPTER_FAILED'
        transport.create_json(job['resultFileId'], job['outputFolderId'], f"sns-studio-result-{expected_job_id}-a{expected_attempt}.json", dict(**result_base, status='FAILED', errorCode=code, errorMessage=code))
        raise
    # Upload failures preserve completed output for a same-runtime resync.
    # No failed result is written for transport failures after valid inference.
    props = dict(jobId=expected_job_id, attempt=str(expected_attempt), inputHash=job['inputHash'], sha256=info['sha256'])
    transport.upload_output(job['outputFileId'], job['jobFolderId'], output, props)
    check_cancel()
    result = dict(**result_base, status='COMPLETE', execution=evidence, outputs=[dict(fileId=job['outputFileId'], name=output.name, mimeType='video/mp4', **info)])
    try:
        transport.create_json(job['resultFileId'], job['outputFolderId'], f"sns-studio-result-{expected_job_id}-a{expected_attempt}.json", result)
    except Exception as error:
        if getattr(getattr(error, 'resp', None), 'status', None) != 409 or canonical_hash(transport.json(job['resultFileId'])) != canonical_hash(result):
            raise
    return result
