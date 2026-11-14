from hashlib import sha256
import subprocess
from fastapi.testclient import TestClient
from app.main import create_app


def test_generation_video_requires_auth_and_full_decode(tmp_path, monkeypatch):
    monkeypatch.setenv('MEDIA_ROOT', str(tmp_path))
    monkeypatch.setenv('SNS_STUDIO_SERVICE_TOKEN', 'isolated-fixture-token')
    video = tmp_path/'fixture.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=480x848:rate=16', '-frames:v', '49', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(video)], check=True)
    client = TestClient(create_app())
    assert client.post('/generation/validate-video', json={'path': str(video)}).status_code == 401
    headers = {'Authorization': 'Bearer isolated-fixture-token'}
    response = client.post('/generation/validate-video', json={'path': str(video)}, headers=headers)
    assert response.status_code == 200
    assert response.json()['sha256'] == sha256(video.read_bytes()).hexdigest()
    assert response.json()['numFrames'] == 49
    assert response.json()['fullDecode'] is True
    assert response.json()['sizeBytes'] == video.stat().st_size
    corrupt = tmp_path/'bad.mp4'
    corrupt.write_bytes(b'\x00\x00\x00\x20ftypmp42')
    assert client.post('/generation/validate-video', json={'path': str(corrupt)}, headers=headers).status_code == 422
