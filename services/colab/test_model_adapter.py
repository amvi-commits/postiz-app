"""
Tests for SNS Studio Colab Model Adapter
========================================
Validates the adapter interface, parameter parsing, enhanced prompts,
fail-closed GPU guard, official checkpoints, pipeline classes, and mock generation.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path

from sns_studio_model_adapter import (
    SUPPORTED_MODELS,
    build_enhanced_prompt,
    check_gpu_environment,
    generate,
    generate_mock_video,
    normalize_model_id,
    select_torch_dtype,
)


class TestColabModelAdapter(unittest.TestCase):
    def test_supported_models_contract(self):
        # 1. Wan2.1 T2V 1.3B
        self.assertIn("wan-2.1-t2v-1.3b", SUPPORTED_MODELS)
        self.assertEqual(SUPPORTED_MODELS["wan-2.1-t2v-1.3b"]["pipeline_class"], "WanPipeline")
        self.assertEqual(SUPPORTED_MODELS["wan-2.1-t2v-1.3b"]["repo_id"], "Wan-AI/Wan2.1-T2V-1.3B-Diffusers")

        # 2. LTX-Video T2V & I2V
        self.assertIn("ltx-video-0.9.1-t2v", SUPPORTED_MODELS)
        self.assertIn("ltx-video-0.9.1-i2v", SUPPORTED_MODELS)
        self.assertEqual(SUPPORTED_MODELS["ltx-video-0.9.1-t2v"]["pipeline_class"], "LTXPipeline")
        self.assertEqual(SUPPORTED_MODELS["ltx-video-0.9.1-i2v"]["pipeline_class"], "LTXImageToVideoPipeline")
        self.assertEqual(SUPPORTED_MODELS["ltx-video-0.9.1-i2v"]["repo_id"], "Lightricks/LTX-Video")

        # 3. Wan2.1 I2V 14B (High-end A100)
        self.assertIn("wan-2.1-i2v-14b", SUPPORTED_MODELS)
        self.assertEqual(SUPPORTED_MODELS["wan-2.1-i2v-14b"]["pipeline_class"], "WanImageToVideoPipeline")
        self.assertEqual(SUPPORTED_MODELS["wan-2.1-i2v-14b"]["repo_id"], "Wan-AI/Wan2.1-I2V-14B-480P-Diffusers")

    def test_normalize_model_id(self):
        self.assertEqual(normalize_model_id("Wan2.1-T2V-1.3B", "text-to-video"), "wan-2.1-t2v-1.3b")
        self.assertEqual(normalize_model_id("ltx-video-0.9.1", "image-to-video"), "ltx-video-0.9.1-i2v")
        self.assertEqual(normalize_model_id("ltx-video-0.9.1", "text-to-video"), "ltx-video-0.9.1-t2v")
        self.assertEqual(normalize_model_id("wan-2.1-i2v-14b", "image-to-video"), "wan-2.1-i2v-14b")

    def test_build_enhanced_prompt_with_reference(self):
        base_prompt = "A girl dancing in neon street"
        ref_analysis = {
            "aspectRatio": "9:16",
            "tempo": "FAST",
        }
        enhanced = build_enhanced_prompt(base_prompt, ref_analysis)
        self.assertIn("vertical 9:16 composition", enhanced)
        self.assertIn("dynamic fast-paced movement", enhanced)
        self.assertIn(base_prompt, enhanced)

    def test_build_enhanced_prompt_without_reference(self):
        base_prompt = "Calm river flowing"
        self.assertEqual(build_enhanced_prompt(base_prompt, None), base_prompt)

    def test_generate_requires_valid_input(self):
        with tempfile.TemporaryDirectory() as out_dir:
            # Missing prompt
            with self.assertRaises(ValueError):
                generate({"jobId": "test1", "input": {"prompt": ""}}, out_dir)

            # I2V requires referenceImage
            with self.assertRaises(ValueError):
                generate(
                    {
                        "jobId": "test3",
                        "input": {
                            "prompt": "test",
                            "mode": "image-to-video",
                            "mock": True,
                        },
                    },
                    out_dir,
                )

    def test_generate_fail_closed_without_gpu_when_not_mock(self):
        gpu_info = check_gpu_environment()
        if not gpu_info["cuda_available"]:
            with tempfile.TemporaryDirectory() as out_dir:
                job = {
                    "jobId": "real-job-1",
                    "input": {
                        "mode": "text-to-video",
                        "modelName": "wan-2.1-t2v-1.3b",
                        "prompt": "Test video",
                        "mock": False,
                    },
                }
                with self.assertRaises(RuntimeError) as ctx:
                    generate(job, out_dir)
                self.assertIn("BLOCKED_BY_GPU", str(ctx.exception))

    def test_generate_mock_mode_produces_mp4_in_output_dir(self):
        if not shutil.which("ffmpeg"):
            self.skipTest("ffmpeg not found in PATH")

        with tempfile.TemporaryDirectory() as out_dir:
            job = {
                "jobId": "test-mock-job",
                "input": {
                    "mode": "text-to-video",
                    "modelName": "wan-2.1-t2v-1.3b",
                    "prompt": "Cyberpunk street in rain",
                    "mock": True,
                    "durationSeconds": 2.0,
                    "aspectRatio": "9:16",
                    "resolution": "480p",
                },
            }
            outputs = generate(job, out_dir)
            self.assertEqual(len(outputs), 1)
            output_file = Path(outputs[0])
            self.assertTrue(output_file.exists())
            self.assertTrue(output_file.is_file())
            self.assertGreater(output_file.stat().st_size, 1000)
            self.assertTrue(str(output_file).endswith(".mp4"))


if __name__ == "__main__":
    unittest.main()
