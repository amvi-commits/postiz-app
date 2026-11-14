"""CPU contract tests. Synthetic encoding is explicitly not real AI E2E."""
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
from sns_studio_model_adapter import (
    SUPPORTED_MODELS, canonical_hash, normalize_model_id, validate_input,
    generate, generate_mock_video, validate_reference_image, validate_video,
    select_torch_dtype, execution_profile,
)


class TestColabModelAdapter(unittest.TestCase):
    def test_t4_emulated_bfloat16_does_not_select_a_native_bfloat16_kernel(self):
        fake = SimpleNamespace(float16='float16', bfloat16='bfloat16', cuda=SimpleNamespace(get_device_capability=lambda *_: (7, 5), is_bf16_supported=lambda **_: True))
        with patch.dict('sys.modules', {'torch': fake}):
            self.assertEqual(select_torch_dtype(), 'float16')
        fake.cuda.get_device_capability = lambda *_: (8, 0)
        with patch.dict('sys.modules', {'torch': fake}):
            self.assertEqual(select_torch_dtype(), 'bfloat16')

    def test_memory_policy_exposes_slow_offload_instead_of_claiming_vram_guarantees(self):
        profile = execution_profile({'vram_gb': 14.56, 'bf16_supported': False}, 'wan-2.1-t2v-1.3b')
        self.assertEqual(profile['cpuOffloadMode'], 'sequential_cpu')
        self.assertEqual(profile['dtype'], 'float16')
        self.assertEqual(profile['maxSequenceLength'], 512)
        self.assertEqual(execution_profile({'vram_gb': 24, 'bf16_supported': True}, 'ltx-video-0.9.1-i2v')['cpuOffloadMode'], 'model_cpu')

    def test_exact_pinned_model_contract(self):
        for model in SUPPORTED_MODELS.values():
            self.assertRegex(model['revision'], r'^[0-9a-f]{40}$')
            self.assertFalse(model['real_e2e_verified'])
            for size in model['sizes'].values():
                self.assertTrue(all(value % model['spatial_stride'] == 0 for value in size))
        self.assertEqual(SUPPORTED_MODELS['ltx-video-0.9.1-i2v']['repo_id'], 'Lightricks/LTX-Video-0.9.1')
        self.assertEqual(SUPPORTED_MODELS['ltx-video-0.9.1-i2v']['pipeline_class'], 'LTXImageToVideoPipeline')

    def test_defaults_and_explicit_invalid_models_modes(self):
        self.assertEqual(normalize_model_id(None, 'image-to-video'), 'ltx-video-0.9.1-i2v')
        for model, mode in [('unknown', 'text-to-video'), ('', 'text-to-video'), ('wan-2.1-t2v-1.3b', 'image-to-video'), ('ltx-video-0.9.1-t2v', 'image-to-video'), (None, 'unknown')]:
            with self.subTest(model=model, mode=mode), self.assertRaises(ValueError):
                normalize_model_id(model, mode)

    def test_input_bounds_types_seed_zero_and_model_grid(self):
        normalized = validate_input({'prompt': 'A mug', 'seed': 0})
        self.assertEqual(normalized['seed'], 0)
        self.assertEqual(normalized['adopted']['numFrames'], 49)
        for model in SUPPORTED_MODELS:
            mode = SUPPORTED_MODELS[model]['modes'][0]
            for duration in (2, 3, 4):
                raw = dict(prompt='A mug', modelName=model, mode=mode, durationSeconds=duration)
                if mode == 'image-to-video':
                    raw['referenceImageAssetId'] = 'image-test'
                result = validate_input(raw)
                self.assertEqual((result['adopted']['numFrames']-1) % SUPPORTED_MODELS[model]['frame_stride'], 0)
                self.assertEqual(validate_input(result), result)
        for key, value in [('mock', 'false'), ('mock', 0), ('seed', '0'), ('seed', -1), ('seed', True), ('durationSeconds', 0), ('durationSeconds', 5), ('durationSeconds', '3'), ('count', 2), ('numInferenceSteps', 51), ('resolution', '720p'), ('prompt', []), ('referenceImage', '/etc/passwd'), ('width', 99999)]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                validate_input({'prompt': 'mug', key: value})

    def test_mock_requires_explicit_test_permission_and_environment_is_not_truthy(self):
        with tempfile.TemporaryDirectory() as out:
            with patch.dict(os.environ, {'MOCK_GENERATION': 'true'}), self.assertRaisesRegex(ValueError, 'MOCK_ENVIRONMENT'):
                generate({'jobId': 'test', 'input': {'prompt': 'mug', 'mock': False}}, out)
            with patch.dict(os.environ, {'SNS_STUDIO_ALLOW_TEST_MOCK': '0', 'MOCK_GENERATION': 'false'}), self.assertRaisesRegex(ValueError, 'MOCK_NOT_ALLOWED'):
                generate({'jobId': 'test', 'input': {'prompt': 'mug', 'mock': True}}, out)

    def test_real_generation_fails_closed_without_gpu(self):
        with tempfile.TemporaryDirectory() as out, patch('sns_studio_model_adapter.check_gpu_environment', return_value={'cuda_available': False}), patch('sns_studio_model_adapter.run_oss_pipeline') as pipeline:
            with self.assertRaisesRegex(RuntimeError, 'BLOCKED_BY_GPU'):
                generate({'jobId': 'real-test', 'input': {'prompt': 'mug', 'mock': False}}, out)
            pipeline.assert_not_called()

    def test_mock_ffmpeg_failure_never_returns_header(self):
        with tempfile.TemporaryDirectory() as out, patch('sns_studio_model_adapter.subprocess.run', side_effect=subprocess.CalledProcessError(1, ['ffmpeg'])):
            path = Path(out)/'test.mp4'
            with self.assertRaisesRegex(RuntimeError, 'MOCK_VIDEO_ENCODING_FAILED'):
                generate_mock_video(path)
            self.assertFalse(path.exists())

    def test_synthetic_clip_requires_probe_and_full_decode(self):
        with tempfile.TemporaryDirectory() as out, patch.dict(os.environ, {'SNS_STUDIO_ALLOW_TEST_MOCK': '1', 'MOCK_GENERATION': 'false'}):
            paths = generate({'jobId': 'mock-test', 'input': {'prompt': 'mug', 'mock': True, 'durationSeconds': 2}}, out)
            metadata = validate_video(Path(paths[0]))
            self.assertTrue(metadata['fullDecode'])
            self.assertGreater(metadata['numFrames'], 1)
            self.assertEqual(metadata['sizeBytes'], Path(paths[0]).stat().st_size)
            self.assertTrue(json.loads((Path(out)/'generation-evidence.json').read_text())['mock'])
            bad = Path(out)/'header-only.mp4'
            bad.write_bytes(b'\x00\x00\x00\x20ftypmp42')
            with self.assertRaises(ValueError):
                validate_video(bad)

    def test_i2v_image_decode_hash_size_and_path(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as out:
            root = Path(out)
            image = root/'test.png'
            Image.new('RGB', (64, 64), 'blue').save(image)
            ref = dict(fileId='drive-image', sizeBytes=image.stat().st_size, sha256=hashlib.sha256(image.read_bytes()).hexdigest(), mimeType='image/png')
            job = {'input': {'referenceImage': ref}, 'localReferenceImage': str(image)}
            self.assertEqual(validate_reference_image(job, root), image)
            with self.assertRaisesRegex(ValueError, 'HASH_MISMATCH'):
                validate_reference_image({'input': {'referenceImage': {**ref, 'sha256': '0'*64}}, 'localReferenceImage': str(image)}, root)
            with self.assertRaisesRegex(ValueError, 'PATH_INVALID'):
                validate_reference_image({'input': {'referenceImage': ref}, 'localReferenceImage': '/etc/passwd'}, root)

    def test_hash_is_canonical_and_rejects_nonfinite(self):
        self.assertEqual(canonical_hash({'z': 0, 'a': 'マグ'}), canonical_hash({'a': 'マグ', 'z': 0}))
        with self.assertRaises(ValueError):
            canonical_hash({'seed': float('nan')})


if __name__ == '__main__':
    unittest.main()
