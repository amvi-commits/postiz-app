"""
SNS Studio Colab Model Adapter
==============================
Provides the `generate(job: dict, output_dir: str) -> list[str]` interface required
by `services/colab/sns_studio_worker.ipynb`.

Supported Modes:
1. text-to-video (T2V)
2. image-to-video (I2V)

Supported Official OSS Video Generation Models (Hugging Face Checkpoints):
- Wan2.1-T2V-1.3B (Wan-AI/Wan2.1-T2V-1.3B-Diffusers): Lightweight T2V (Colab T4/L4/A100)
- LTX-Video-0.9.1 (Lightricks/LTX-Video): Fast transformer-based T2V and I2V (Colab T4/L4/A100)
- Wan2.1-I2V-14B-480P (Wan-AI/Wan2.1-I2V-14B-480P-Diffusers): High-fidelity I2V (Requires A100 GPU 40GB+)

Hardware Requirements:
- Google Colab GPU (NVIDIA T4 16GB, L4 24GB, or A100)
- Windows PC integrated GPU is NOT supported for AI generation (Fail-closed guard activates).
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

# Model configuration constants with official Hugging Face repositories and pipeline classes
SUPPORTED_MODELS: dict[str, dict[str, Any]] = {
    # 1. Text-to-Video
    "wan-2.1-t2v-1.3b": {
        "name": "Wan2.1 T2V (1.3B)",
        "modes": ["text-to-video"],
        "min_vram_gb": 12,
        "recommended_resolution": (480, 832),
        "fps": 16,
        "repo_id": "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
        "pipeline_class": "WanPipeline",
        "gpu_note": "Colab T4 (16GB) / L4 (24GB) / A100 推奨",
    },
    "ltx-video-0.9.1-t2v": {
        "name": "LTX-Video (0.9.1 T2V)",
        "modes": ["text-to-video"],
        "min_vram_gb": 12,
        "recommended_resolution": (480, 704),
        "fps": 24,
        "repo_id": "Lightricks/LTX-Video",
        "pipeline_class": "LTXPipeline",
        "gpu_note": "Colab T4 / L4 / A100 推奨 (高速推論)",
    },
    # 2. Image-to-Video
    "ltx-video-0.9.1-i2v": {
        "name": "LTX-Video (0.9.1 I2V)",
        "modes": ["image-to-video"],
        "min_vram_gb": 12,
        "recommended_resolution": (480, 704),
        "fps": 24,
        "repo_id": "Lightricks/LTX-Video",
        "pipeline_class": "LTXImageToVideoPipeline",
        "gpu_note": "Colab T4 / L4 / A100 推奨 (I2V対応)",
    },
    "wan-2.1-i2v-14b": {
        "name": "Wan2.1 I2V (14B-480P)",
        "modes": ["image-to-video"],
        "min_vram_gb": 32,
        "recommended_resolution": (480, 832),
        "fps": 16,
        "repo_id": "Wan-AI/Wan2.1-I2V-14B-480P-Diffusers",
        "pipeline_class": "WanImageToVideoPipeline",
        "gpu_note": "要A100 GPU (VRAM 40GB+)。T4ではOOMするためColab Pro/Pro+専用",
    },
}

# Alias mapping for backwards compatibility and user convenience
MODEL_ALIASES: dict[str, str] = {
    "Wan2.1-T2V-1.3B": "wan-2.1-t2v-1.3b",
    "wan-2.1-t2v-1.3b": "wan-2.1-t2v-1.3b",
    "LTX-Video-0.9.1": "ltx-video-0.9.1-t2v",
    "ltx-video-0.9.1": "ltx-video-0.9.1-t2v",
    "ltx-video": "ltx-video-0.9.1-t2v",
    "ltx-video-i2v": "ltx-video-0.9.1-i2v",
    "Wan2.1-I2V-14B": "wan-2.1-i2v-14b",
    "wan-2.1-i2v-14b": "wan-2.1-i2v-14b",
}


def normalize_model_id(raw_name: str, mode: str) -> str:
    """Normalize model identifier based on mode and aliases."""
    if not raw_name:
        return "wan-2.1-t2v-1.3b" if mode == "text-to-video" else "ltx-video-0.9.1-i2v"

    normalized = MODEL_ALIASES.get(raw_name, raw_name.lower())
    if normalized == "ltx-video-0.9.1-t2v" and mode == "image-to-video":
        return "ltx-video-0.9.1-i2v"
    if normalized in SUPPORTED_MODELS:
        return normalized

    # Fallback to defaults
    if mode == "image-to-video":
        return "ltx-video-0.9.1-i2v"
    return "wan-2.1-t2v-1.3b"


def check_gpu_environment() -> dict[str, Any]:
    """Detect available GPU, VRAM, and bfloat16 support."""
    try:
        import torch

        if not torch.cuda.is_available():
            return {
                "cuda_available": False,
                "device_name": "None",
                "vram_gb": 0.0,
                "bf16_supported": False,
            }
        device_name = torch.cuda.get_device_name(0)
        vram_bytes = torch.cuda.get_device_properties(0).total_memory
        vram_gb = round(vram_bytes / (1024**3), 2)
        bf16_supported = torch.cuda.is_bf16_supported() if hasattr(torch.cuda, "is_bf16_supported") else False
        return {
            "cuda_available": True,
            "device_name": device_name,
            "vram_gb": vram_gb,
            "bf16_supported": bf16_supported,
        }
    except ImportError:
        return {
            "cuda_available": False,
            "device_name": "PyTorch not installed",
            "vram_gb": 0.0,
            "bf16_supported": False,
        }


def select_torch_dtype() -> Any:
    """Safely select torch dtype according to CUDA hardware capability."""
    import torch

    gpu_info = check_gpu_environment()
    if gpu_info.get("bf16_supported", False):
        return torch.bfloat16
    return torch.float16


def build_enhanced_prompt(prompt: str, reference_analysis: dict | None = None) -> str:
    """Enhance user prompt using reference video analysis if available."""
    if not reference_analysis or not isinstance(reference_analysis, dict):
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
    duration_seconds: float = 3.0,
    fps: int = 16,
    label: str = "AI Video Tools Mock",
) -> Path:
    """Generate a clean synthetic MP4 using FFmpeg (for automated tests and CI)."""
    ffmpeg_bin = shutil.which("ffmpeg") or "ffmpeg"
    temp_raw = output_path.with_suffix(".mock.mp4")

    # Generate color test pattern with text overlay
    cmd = [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"testsrc=duration={duration_seconds}:size={width}x{height}:rate={fps}",
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency=440:duration={duration_seconds}",
        "-vf",
        f"drawtext=text='{label}':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=(h-text_h)/2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-shortest",
        str(temp_raw),
    ]

    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=30)
        temp_raw.replace(output_path)
    except Exception as err:
        logger.warning(f"FFmpeg synthetic video failed ({err}), creating minimal placeholder")
        output_path.write_bytes(b"\x00\x00\x00\x20ftypmp42\x00\x00\x00\x00isommp42")

    return output_path


def run_oss_pipeline(
    model_id: str,
    mode: str,
    prompt: str,
    negative_prompt: str,
    output_path: Path,
    image_path: str | None = None,
    width: int = 480,
    height: int = 832,
    duration_seconds: float = 3.0,
    fps: int = 16,
    num_inference_steps: int = 25,
    seed: int | None = None,
) -> Path:
    """
    Run genuine OSS model pipeline with PyTorch and Diffusers.
    Directs to the specific pipeline class according to model and mode.
    """
    import torch

    model_config = SUPPORTED_MODELS[model_id]
    num_frames = int(duration_seconds * fps)
    dtype = select_torch_dtype()
    generator = torch.Generator(device="cuda").manual_seed(seed) if seed is not None else None

    logger.info(
        f"Starting {model_config['name']} ({mode}) generation using {dtype}: prompt='{prompt[:50]}...', "
        f"size={width}x{height}, frames={num_frames}, fps={fps}"
    )

    temp_video = output_path.with_suffix(".raw.mp4")

    # 1. Wan2.1 T2V
    if model_id == "wan-2.1-t2v-1.3b":
        from diffusers import AutoModel, WanPipeline
        from diffusers.utils import export_to_video

        pipe = WanPipeline.from_pretrained(
            model_config["repo_id"],
            torch_dtype=dtype,
        )
        pipe.enable_model_cpu_offload()

        output = pipe(
            prompt=prompt,
            negative_prompt=negative_prompt,
            height=height,
            width=width,
            num_frames=num_frames,
            guidance_scale=5.0,
            generator=generator,
        ).frames[0]

        export_to_video(output, str(temp_video), fps=fps)

    # 2. Wan2.1 I2V (14B)
    elif model_id == "wan-2.1-i2v-14b":
        from diffusers import WanImageToVideoPipeline
        from diffusers.utils import export_to_video, load_image

        if not image_path or not Path(image_path).exists():
            raise ValueError(f"Valid reference image path is required for {model_id}")

        pipe = WanImageToVideoPipeline.from_pretrained(
            model_config["repo_id"],
            torch_dtype=dtype,
        )
        pipe.enable_model_cpu_offload()

        input_image = load_image(image_path).resize((width, height))

        output = pipe(
            image=input_image,
            prompt=prompt,
            negative_prompt=negative_prompt,
            height=height,
            width=width,
            num_frames=num_frames,
            guidance_scale=5.0,
            generator=generator,
        ).frames[0]

        export_to_video(output, str(temp_video), fps=fps)

    # 3. LTX-Video T2V
    elif model_id == "ltx-video-0.9.1-t2v":
        from diffusers import LTXPipeline
        from diffusers.utils import export_to_video

        pipe = LTXPipeline.from_pretrained(
            model_config["repo_id"],
            torch_dtype=dtype,
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

        export_to_video(output, str(temp_video), fps=fps)

    # 4. LTX-Video I2V
    elif model_id == "ltx-video-0.9.1-i2v":
        from diffusers import LTXImageToVideoPipeline
        from diffusers.utils import export_to_video, load_image

        if not image_path or not Path(image_path).exists():
            raise ValueError(f"Valid reference image path is required for {model_id}")

        pipe = LTXImageToVideoPipeline.from_pretrained(
            model_config["repo_id"],
            torch_dtype=dtype,
        )
        pipe.enable_model_cpu_offload()

        input_image = load_image(image_path).resize((width, height))

        output = pipe(
            image=input_image,
            prompt=prompt,
            negative_prompt=negative_prompt,
            width=width,
            height=height,
            num_frames=num_frames,
            num_inference_steps=num_inference_steps,
            generator=generator,
        ).frames[0]

        export_to_video(output, str(temp_video), fps=fps)

    else:
        raise ValueError(f"Unsupported model: {model_id}")

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

    Accepts structured job manifest matching SNS Studio backend:
    - job['input'] contains: prompt, mode, modelName, durationSeconds, referenceImage, etc.
    """
    job_id = job.get("jobId") or job.get("id") or str(uuid4())[:8]
    job_input = job.get("input", {})
    if not isinstance(job_input, dict):
        job_input = {}

    prompt = (job_input.get("prompt") or job.get("prompt") or "").strip()
    mode = (
        job_input.get("mode")
        or job.get("mode")
        or ("image-to-video" if (job_input.get("referenceImage") or job.get("referenceImage")) else "text-to-video")
    )
    raw_model = (
        job_input.get("modelName")
        or job_input.get("model")
        or job.get("model")
        or "wan-2.1-t2v-1.3b"
    )
    model_id = normalize_model_id(raw_model, mode)
    model_config = SUPPORTED_MODELS[model_id]

    reference_image = job_input.get("referenceImage") or job.get("referenceImage")
    duration_seconds = float(job_input.get("durationSeconds") or job.get("durationSeconds") or 3.0)
    seed = job_input.get("seed") or job.get("seed")
    if seed is not None:
        try:
            seed = int(seed)
        except (ValueError, TypeError):
            seed = None

    reference_analysis = job_input.get("referenceAnalysis") or job.get("referenceAnalysis")
    is_mock = bool(job_input.get("mock") or job.get("mock") or os.environ.get("MOCK_GENERATION") == "true")

    # Manifest validation
    if not prompt:
        raise ValueError("Job input manifest requires a non-empty 'prompt'.")

    # Image-to-Video validation
    if mode == "image-to-video" and not reference_image:
        raise ValueError("Image-to-Video generation requires a valid 'referenceImage' in input manifest.")

    enhanced_prompt = build_enhanced_prompt(prompt, reference_analysis)
    negative_prompt = (
        job_input.get("negativePrompt")
        or "worst quality, blurry, distorted, inconsistent motion, artifacts, deformed"
    )

    # Resolution & aspect ratio calculations
    aspect_ratio = job_input.get("aspectRatio") or job.get("aspectRatio") or "9:16"
    resolution = job_input.get("resolution") or job.get("resolution") or "480p"
    if aspect_ratio == "9:16":
        width, height = (480, 848) if resolution == "480p" else (720, 1280)
    elif aspect_ratio == "16:9":
        width, height = (848, 480) if resolution == "480p" else (1280, 720)
    else:
        width, height = (480, 480) if resolution == "480p" else (720, 720)

    fps = model_config.get("fps", 16)
    out_dir_path = Path(output_dir)
    out_dir_path.mkdir(parents=True, exist_ok=True)
    target_video_path = out_dir_path / f"sns_studio_{job_id}_{model_id}.mp4"

    # MOCK MODE (For automated E2E testing without real GPU)
    if is_mock:
        logger.info(f"[MOCK MODE] Generating synthetic video for Job #{job_id}")
        generate_mock_video(
            target_video_path,
            width=width,
            height=height,
            duration_seconds=duration_seconds,
            fps=fps,
            label=f"Mock: {model_config['name']}",
        )
        return [str(target_video_path)]

    # REAL GPU MODE - Guard against non-GPU / insufficient VRAM environments
    gpu_info = check_gpu_environment()
    min_vram = model_config.get("min_vram_gb", 12)
    if not gpu_info["cuda_available"] or gpu_info["vram_gb"] < min_vram:
        msg = (
            f"BLOCKED_BY_GPU: CUDA GPU with >={min_vram}GB VRAM required for {model_config['name']}. "
            f"Detected: {gpu_info['device_name']} (VRAM: {gpu_info['vram_gb']}GB). "
            f"Please run services/colab/sns_studio_worker.ipynb on Google Colab GPU ({model_config['gpu_note']})."
        )
        logger.error(msg)
        raise RuntimeError(msg)

    # Run genuine OSS Diffusers pipeline
    run_oss_pipeline(
        model_id=model_id,
        mode=mode,
        prompt=enhanced_prompt,
        negative_prompt=negative_prompt,
        output_path=target_video_path,
        image_path=reference_image,
        width=width,
        height=height,
        duration_seconds=duration_seconds,
        fps=fps,
        seed=seed,
    )

    return [str(target_video_path)]
