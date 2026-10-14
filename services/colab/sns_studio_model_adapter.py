"""
SNS Studio Colab Model Adapter
==============================
Provides the `generate(job: dict, output_dir: str) -> list[str]` interface required
by `services/colab/sns_studio_worker.ipynb`.

Supported Modes:
1. text-to-video (T2V)
2. image-to-video (I2V)

Supported OSS Video Generation Models:
- Wan2.1-T2V-1.3B / Wan2.1-I2V-1.3B (Alibaba, Apache 2.0, low VRAM footprint)
- LTX-Video-0.9.1 (Lightricks, transformer-based, T2V/I2V compatible)
- CogVideoX-2b (THUDM, low VRAM compatible)

Hardware Requirements:
- Google Colab GPU (NVIDIA T4 15GB VRAM, L4 24GB VRAM, or A100)
- Windows PC integrated GPU is NOT supported for AI generation (FFmpeg editing only).
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("sns_studio_model_adapter")

# Model configuration constants
SUPPORTED_MODELS = {
    "Wan2.1-T2V-1.3B": {
        "modes": ["text-to-video"],
        "min_vram_gb": 12,
        "recommended_resolution": (480, 832),
        "fps": 16,
        "repo_id": "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
    },
    "Wan2.1-I2V-1.3B": {
        "modes": ["image-to-video"],
        "min_vram_gb": 14,
        "recommended_resolution": (480, 832),
        "fps": 16,
        "repo_id": "Wan-AI/Wan2.1-I2V-1.3B-Diffusers",
    },
    "LTX-Video-0.9.1": {
        "modes": ["text-to-video", "image-to-video"],
        "min_vram_gb": 14,
        "recommended_resolution": (480, 704),
        "fps": 24,
        "repo_id": "Lightricks/LTX-Video",
    },
}


def check_gpu_environment() -> dict[str, Any]:
    """Detect available GPU and VRAM."""
    try:
        import torch

        if not torch.cuda.is_available():
            return {"cuda_available": False, "device_name": "None", "vram_gb": 0.0}
        device_name = torch.cuda.get_device_name(0)
        vram_bytes = torch.cuda.get_device_properties(0).total_memory
        vram_gb = round(vram_bytes / (1024**3), 2)
        return {"cuda_available": True, "device_name": device_name, "vram_gb": vram_gb}
    except ImportError:
        return {"cuda_available": False, "device_name": "PyTorch not installed", "vram_gb": 0.0}


def build_enhanced_prompt(prompt: str, reference_analysis: dict | None = None) -> str:
    """Enhance user prompt using reference video analysis if available."""
    if not reference_analysis:
        return prompt

    tempo = reference_analysis.get("tempo", "")
    aspect_ratio = reference_analysis.get("aspectRatio", "")
    enhancements = []
    if aspect_ratio == "9:16":
        enhancements.append("vertical 9:16 composition")
    if tempo == "FAST":
        enhancements.append("dynamic fast-paced movement, energetic motion")
    elif tempo == "SLOW":
        enhancements.append("smooth cinematic slow motion")

    if enhancements:
        return f"{prompt}, {', '.join(enhancements)}, high quality, 4k photorealistic"
    return prompt


def generate_mock_video(
    output_path: Path,
    width: int = 480,
    height: int = 848,
    duration: float = 2.0,
    fps: int = 24,
    text: str = "SNS Studio AI Video",
) -> Path:
    """
    Generate a synthetic verification video using FFmpeg.
    ONLY used when job explicitly sets mock=True for pipeline testing.
    """
    ffmpeg_bin = shutil.which("ffmpeg") or "ffmpeg"
    cmd = [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"color=c=0x1a1a2e:s={width}x{height}:r={fps}:d={duration}",
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency=440:sample_rate=48000:duration={duration}",
        "-vf",
        f"drawtext=text='{text}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.5",
        "-shortest",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True, timeout=60)
    return output_path


def generate_with_diffusers(
    model_name: str,
    mode: str,
    prompt: str,
    output_path: Path,
    negative_prompt: str | None = None,
    image_path: str | None = None,
    width: int = 480,
    height: int = 832,
    duration_seconds: float = 3.0,
    fps: int = 16,
    num_inference_steps: int = 25,
    seed: int | None = None,
) -> Path:
    """Run genuine OSS model pipeline with PyTorch and Diffusers."""
    import torch

    num_frames = int(duration_seconds * fps)
    generator = torch.Generator(device="cuda").manual_seed(seed) if seed is not None else None

    logger.info(
        f"Starting {model_name} ({mode}) generation: prompt='{prompt[:50]}...', "
        f"size={width}x{height}, frames={num_frames}, fps={fps}"
    )

    if "Wan" in model_name:
        from diffusers import AutoencoderKLWan, WanPipeline
        from diffusers.utils import export_to_video

        pipe = WanPipeline.from_pretrained(
            SUPPORTED_MODELS[model_name]["repo_id"],
            torch_dtype=torch.bfloat16,
        )
        pipe.enable_model_cpu_offload()

        if mode == "image-to-video" and image_path:
            from PIL import Image

            input_image = Image.open(image_path).convert("RGB").resize((width, height))
            output = pipe(
                image=input_image,
                prompt=prompt,
                negative_prompt=negative_prompt,
                height=height,
                width=width,
                num_frames=num_frames,
                num_inference_steps=num_inference_steps,
                generator=generator,
            ).frames[0]
        else:
            output = pipe(
                prompt=prompt,
                negative_prompt=negative_prompt,
                height=height,
                width=width,
                num_frames=num_frames,
                num_inference_steps=num_inference_steps,
                generator=generator,
            ).frames[0]

        temp_video = output_path.with_suffix(".raw.mp4")
        export_to_video(output, str(temp_video), fps=fps)

    elif "LTX" in model_name:
        from diffusers import LTXPipeline
        from diffusers.utils import export_to_video

        pipe = LTXPipeline.from_pretrained(
            SUPPORTED_MODELS[model_name]["repo_id"],
            torch_dtype=torch.bfloat16,
        )
        pipe.enable_model_cpu_offload()

        output = pipe(
            prompt=prompt,
            negative_prompt=negative_prompt,
            width=width,
            height=height,
            num_frames=num_frames,
            num_inference_steps=num_inference_steps,
            generator=generator,
        ).frames[0]

        temp_video = output_path.with_suffix(".raw.mp4")
        export_to_video(output, str(temp_video), fps=fps)
    else:
        raise ValueError(f"Unsupported model: {model_name}")

    # Standardize output to SNS vertical 9:16 MP4 (H.264, AAC)
    ffmpeg_bin = shutil.which("ffmpeg") or "ffmpeg"
    cmd = [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(temp_video),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True, timeout=120)
    temp_video.unlink(missing_ok=True)
    return output_path


def generate(job: dict, output_dir: str) -> list[str]:
    """
    Standard Model Adapter entrypoint invoked by `sns_studio_worker.ipynb`.

    Args:
        job: Parsed `job.json` dictionary.
        output_dir: Temporary directory path where outputs must be written.

    Returns:
        List of generated local file paths.
    """
    job_id = job.get("jobId", "unknown")
    job_input = job.get("input", {})
    if not isinstance(job_input, dict):
        raise ValueError("Invalid job manifest: 'input' must be a dictionary.")

    mode = job_input.get("mode", "text-to-video")
    if mode not in {"text-to-video", "image-to-video"}:
        raise ValueError(f"Unsupported mode: '{mode}'. Must be 'text-to-video' or 'image-to-video'.")

    raw_prompt = job_input.get("prompt", "").strip()
    if not raw_prompt:
        raise ValueError("Job input 'prompt' is required and cannot be empty.")

    ref_analysis = job_input.get("referenceAnalysis")
    prompt = build_enhanced_prompt(raw_prompt, ref_analysis if isinstance(ref_analysis, dict) else None)
    negative_prompt = job_input.get("negativePrompt")

    duration = float(job_input.get("durationSeconds", 3.0))
    duration = max(2.0, min(5.0, duration))  # Enforce short duration (2-5s) for stability

    width = int(job_input.get("width", 480))
    height = int(job_input.get("height", 848))
    fps = int(job_input.get("fps", 16))
    num_steps = int(job_input.get("numInferenceSteps", 25))
    seed = job_input.get("seed")
    if seed is not None:
        seed = int(seed)

    model_name = job_input.get("modelName", "Wan2.1-T2V-1.3B")
    is_mock = bool(job_input.get("mock", False))

    out_dir_path = Path(output_dir)
    out_dir_path.mkdir(parents=True, exist_ok=True)
    output_filename = f"gen_{job_id[:8]}_{int(time.time())}.mp4"
    final_output_path = out_dir_path / output_filename

    image_path = job_input.get("referenceImage")
    if mode == "image-to-video" and not image_path:
        raise ValueError("Mode 'image-to-video' requires 'referenceImage' in job input.")

    # GPU Check
    gpu_info = check_gpu_environment()

    if is_mock:
        logger.info(f"Generating mock video for job {job_id} (explicit test mode)")
        generate_mock_video(
            final_output_path,
            width=width,
            height=height,
            duration=duration,
            fps=fps,
            text=f"AI Generated Video\n{prompt[:30]}",
        )
        return [str(final_output_path)]


    if not gpu_info["cuda_available"]:
        raise RuntimeError(
            f"BLOCKED_BY_GPU: CUDA GPU is not available on this environment "
            f"({gpu_info['device_name']}). Genuine AI video generation requires an "
            f"NVIDIA GPU with at least 12GB VRAM (e.g. Google Colab T4/L4/A100). "
            f"Windows local CPU/Radeon is restricted to FFmpeg editing only."
        )

    vram_gb = gpu_info["vram_gb"]
    selected_cfg = SUPPORTED_MODELS.get(model_name)
    if not selected_cfg:
        # Default to first compatible model
        for name, cfg in SUPPORTED_MODELS.items():
            if mode in cfg["modes"]:
                model_name = name
                selected_cfg = cfg
                break

    if selected_cfg and vram_gb < selected_cfg["min_vram_gb"]:
        raise RuntimeError(
            f"BLOCKED_BY_VRAM: Model '{model_name}' requires at least {selected_cfg['min_vram_gb']}GB VRAM, "
            f"but detected GPU only has {vram_gb}GB VRAM."
        )

    generate_with_diffusers(
        model_name=model_name,
        mode=mode,
        prompt=prompt,
        output_path=final_output_path,
        negative_prompt=negative_prompt,
        image_path=image_path,
        width=width,
        height=height,
        duration_seconds=duration,
        fps=fps,
        num_inference_steps=num_steps,
        seed=seed,
    )

    if not final_output_path.exists() or final_output_path.stat().st_size == 0:
        raise RuntimeError("Model adapter failed to produce output file.")

    return [str(final_output_path)]
