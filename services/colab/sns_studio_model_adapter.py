"""Pinned, bounded OSS video inference. Never substitutes a model or mock output."""
from __future__ import annotations
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

CONTRACT = json.loads(Path(__file__).with_name('model-contract.json').read_text())
SUPPORTED_MODELS = CONTRACT['models']
MODEL_ALIASES = CONTRACT['aliases']


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def normalize_model_id(raw_name: str | None, mode: str) -> str:
    if mode not in ('text-to-video', 'image-to-video'):
        raise ValueError('GENERATION_INPUT_INVALID:mode')
    if raw_name is None:
        raw_name = 'wan-2.1-t2v-1.3b' if mode == 'text-to-video' else 'ltx-video-0.9.1-i2v'
    if not isinstance(raw_name, str) or not raw_name:
        raise ValueError('GENERATION_INPUT_INVALID:modelName')
    model = MODEL_ALIASES.get(raw_name, raw_name)
    if model not in SUPPORTED_MODELS or mode not in SUPPORTED_MODELS[model]['modes']:
        raise ValueError('GENERATION_INPUT_INVALID:model_mode')
    return model


def validate_input(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise ValueError('GENERATION_INPUT_INVALID:input')
    allowed = {'mode', 'modelName', 'prompt', 'negativePrompt', 'durationSeconds', 'resolution', 'aspectRatio', 'seed', 'numInferenceSteps', 'count', 'mock', 'referenceImageAssetId', 'adopted', 'referenceImage'}
    if set(raw) - allowed:
        raise ValueError('GENERATION_INPUT_INVALID:unsupported_field')
    mode = raw.get('mode', 'text-to-video')
    model_id = normalize_model_id(raw.get('modelName'), mode)
    model = SUPPORTED_MODELS[model_id]
    prompt = raw.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 4000:
        raise ValueError('GENERATION_INPUT_INVALID:prompt')
    negative = raw.get('negativePrompt', '')
    if not isinstance(negative, str) or len(negative) > 2000:
        raise ValueError('GENERATION_INPUT_INVALID:negativePrompt')
    if 'mock' in raw and type(raw['mock']) is not bool:
        raise ValueError('GENERATION_INPUT_INVALID:mock')

    def integer(key, default, low, high):
        value = raw.get(key, default)
        if type(value) is not int or not low <= value <= high:
            raise ValueError(f'GENERATION_INPUT_INVALID:{key}')
        return value

    duration = integer('durationSeconds', 3, 2, 4)
    steps = integer('numInferenceSteps', 30, 1, 50)
    seed = integer('seed', 0, 0, 4294967295)
    integer('count', 1, 1, 1)
    ratio = raw.get('aspectRatio', '9:16')
    if raw.get('resolution', '480p') != '480p' or not isinstance(ratio, str) or ratio not in model['sizes']:
        raise ValueError('GENERATION_INPUT_INVALID:resolution_or_ratio')
    width, height = model['sizes'][ratio]
    frames = math.floor((duration * model['fps'] - 1) / model['frame_stride'] + 0.5) * model['frame_stride'] + 1
    adopted = dict(width=width, height=height, fps=model['fps'], numFrames=frames, durationSeconds=frames/model['fps'], reasons=['Dimensions use the model spatial grid; frames use its temporal grid.'], repoId=model['repo_id'], revision=model['revision'], pipeline=model['pipeline_class'])
    if 'adopted' in raw and raw['adopted'] != adopted:
        raise ValueError('GENERATION_INPUT_INVALID:adopted_mismatch')
    result = dict(mode=mode, modelName=model_id, prompt=prompt.strip(), negativePrompt=negative, durationSeconds=duration, resolution='480p', aspectRatio=ratio, numInferenceSteps=steps, seed=seed, count=1, mock=raw.get('mock', False), adopted=adopted)
    if mode == 'image-to-video':
        asset = raw.get('referenceImageAssetId')
        if not isinstance(asset, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', asset):
            raise ValueError('GENERATION_INPUT_INVALID:referenceImageAssetId')
        result['referenceImageAssetId'] = asset
        if 'referenceImage' in raw:
            result['referenceImage'] = raw['referenceImage']
    elif 'referenceImageAssetId' in raw or 'referenceImage' in raw:
        raise ValueError('GENERATION_INPUT_INVALID:referenceImageAssetId')
    return result


def check_gpu_environment() -> dict[str, Any]:
    info = dict(cuda_available=False, device_name='None', vram_gb=0.0, free_vram_gb=0.0, bf16_supported=False, ram_free_gb=None, disk_free_gb=shutil.disk_usage(Path.cwd()).free/2**30)
    try:
        import psutil
        info['ram_free_gb'] = psutil.virtual_memory().available/2**30
    except ImportError:
        pass
    try:
        import torch
        info.update(torch=torch.__version__, cuda=torch.version.cuda)
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            info.update(cuda_available=True, device_name=torch.cuda.get_device_name(0), vram_gb=total/2**30, free_vram_gb=free/2**30, bf16_supported=torch.cuda.is_bf16_supported())
    except ImportError:
        pass
    return info


def select_torch_dtype():
    import torch
    return torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16


def runtime_versions() -> dict:
    names = ['torch', 'torchvision', 'diffusers', 'transformers', 'accelerate', 'huggingface-hub', 'safetensors', 'sentencepiece', 'Pillow', 'imageio', 'imageio-ffmpeg', 'ftfy', 'psutil']
    result = {}
    for name in names:
        try:
            result[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            result[name] = None
    return result


def verify_runtime_versions():
    if sys.version_info[:2] not in ((3, 11), (3, 12)):
        raise RuntimeError('UNVERIFIED_PYTHON_VERSION_USE_PINNED_COLAB_RUNTIME')
    required = dict(line.split('==', 1) for line in Path(__file__).with_name('requirements-colab.txt').read_text().splitlines() if line and not line.startswith('#'))
    for name in ('torch', 'torchvision', 'diffusers', 'transformers', 'accelerate', 'huggingface-hub', 'safetensors', 'sentencepiece', 'Pillow'):
        if (importlib.metadata.version(name).split('+')[0]) != required[name]:
            raise RuntimeError('UNVERIFIED_DEPENDENCY_VERSION')


def build_enhanced_prompt(prompt: str, reference_analysis: dict | None = None) -> str:
    # UI may explicitly append analysis; the adapter does not rewrite prompts.
    return prompt


def validate_video(path: Path) -> dict:
    if path.suffix.lower() != '.mp4' or not path.is_file() or not 1000 <= path.stat().st_size <= CONTRACT['limits']['outputBytes']:
        raise ValueError('OUTPUT_VIDEO_INVALID')
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,nb_read_frames:format=duration', '-of', 'json', str(path)], check=True, capture_output=True, timeout=120)
    data = json.loads(probe.stdout)
    stream = data['streams'][0]
    frames, duration = int(stream['nb_read_frames']), float(data['format']['duration'])
    if stream['codec_name'] != 'h264' or frames < 2 or not math.isfinite(duration) or not 0 < duration <= 6:
        raise ValueError('OUTPUT_VIDEO_INVALID')
    subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-err_detect', 'explode', '-i', str(path), '-map', '0:v:0', '-f', 'null', '-'], check=True, capture_output=True, timeout=120)
    a, b = map(int, stream['avg_frame_rate'].split('/'))
    return dict(sizeBytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest(), durationSeconds=duration, width=stream['width'], height=stream['height'], fps=a/b, numFrames=frames, fullDecode=True, audioGenerated=False)


def generate_mock_video(output_path: Path, width=480, height=848, duration_seconds=3.0, fps=16, label='TEST MOCK') -> Path:
    temporary = output_path.with_suffix('.mock.mp4')
    try:
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'testsrc2=size={width}x{height}:rate={fps}:duration={duration_seconds}', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(temporary)], check=True, capture_output=True, timeout=60)
        validate_video(temporary)
        temporary.replace(output_path)
        return output_path
    except Exception:
        temporary.unlink(missing_ok=True)
        raise RuntimeError('MOCK_VIDEO_ENCODING_FAILED') from None


def validate_reference_image(job: dict, work_dir: Path) -> Path:
    from PIL import Image
    ref = job['input'].get('referenceImage')
    if not isinstance(ref, dict) or not re.fullmatch(r'[a-f0-9]{64}', str(ref.get('sha256', ''))):
        raise ValueError('REFERENCE_IMAGE_MANIFEST_INVALID')
    path = Path(job.get('localReferenceImage', '')).resolve()
    if not path.is_relative_to(work_dir.resolve()) or not path.is_file() or not 0 < path.stat().st_size <= CONTRACT['limits']['imageBytes']:
        raise ValueError('REFERENCE_IMAGE_PATH_INVALID')
    if path.stat().st_size != ref.get('sizeBytes') or hashlib.sha256(path.read_bytes()).hexdigest() != ref['sha256']:
        raise ValueError('REFERENCE_IMAGE_HASH_MISMATCH')
    with Image.open(path) as image:
        expected = {'PNG': 'image/png', 'JPEG': 'image/jpeg', 'WEBP': 'image/webp'}
        if image.format not in expected or ref.get('mimeType') != expected[image.format] or image.width * image.height > CONTRACT['limits']['imagePixels']:
            raise ValueError('REFERENCE_IMAGE_FORMAT_INVALID')
        image.verify()
    with Image.open(path) as image:
        image.load()
    return path


def run_oss_pipeline(input: dict, output_path: Path, image_path: Path | None = None, cancel_check=None) -> dict:
    import torch
    import diffusers
    from diffusers.utils import export_to_video
    model = SUPPORTED_MODELS[input['modelName']]
    adopted = input['adopted']
    dtype = select_torch_dtype()
    torch.cuda.reset_peak_memory_stats()
    kwargs = dict(revision=model['revision'], torch_dtype=dtype, use_safetensors=True)
    if input['modelName'].startswith('wan-'):
        kwargs['vae'] = diffusers.AutoencoderKLWan.from_pretrained(model['repo_id'], subfolder='vae', revision=model['revision'], torch_dtype=torch.float32, use_safetensors=True)
    pipeline = getattr(diffusers, model['pipeline_class']).from_pretrained(model['repo_id'], **kwargs)
    pipeline.enable_model_cpu_offload()
    if hasattr(pipeline.vae, 'enable_tiling'):
        pipeline.vae.enable_tiling()
    args = dict(prompt=input['prompt'], negative_prompt=input['negativePrompt'], width=adopted['width'], height=adopted['height'], num_frames=adopted['numFrames'], num_inference_steps=input['numInferenceSteps'], generator=torch.Generator(device='cuda').manual_seed(input['seed']))
    if input['modelName'].startswith('ltx-'):
        args['frame_rate'] = adopted['fps']
    else:
        args['guidance_scale'] = 5.0
    if image_path is not None:
        from PIL import Image
        with Image.open(image_path) as image:
            args['image'] = image.convert('RGB').resize((adopted['width'], adopted['height']))

    def step_end(pipe, step, timestep, values):
        if cancel_check and step % 5 == 0:
            cancel_check()
        return values
    args['callback_on_step_end'] = step_end
    start = time.monotonic()
    frames = pipeline(**args).frames[0]
    torch.cuda.synchronize()
    elapsed = time.monotonic() - start
    raw = output_path.with_suffix('.raw.mp4')
    export_to_video(frames, str(raw), fps=adopted['fps'])
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(raw), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(output_path)], check=True, capture_output=True, timeout=120)
    raw.unlink(missing_ok=True)
    return dict(dtype=str(dtype), vaeDtype=str(pipeline.vae.dtype), cpuOffload=True, inferenceSeconds=elapsed, peakGpuMemoryBytes=torch.cuda.max_memory_allocated(), peakGpuReservedBytes=torch.cuda.max_memory_reserved(), inputImageUsed=image_path is not None)


def generate(job: dict, output_dir: str) -> list[str]:
    execution_start = time.monotonic()
    if not isinstance(job, dict) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', str(job.get('jobId', ''))):
        raise ValueError('JOB_ID_INVALID')
    input = validate_input(job.get('input'))
    is_mock = input['mock']
    if os.getenv('MOCK_GENERATION', '').lower() not in ('', '0', 'false'):
        raise ValueError('MOCK_ENVIRONMENT_FORBIDDEN')
    if is_mock and os.getenv('SNS_STUDIO_ALLOW_TEST_MOCK') != '1':
        raise ValueError('MOCK_NOT_ALLOWED')
    work_dir = Path(output_dir).resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    image = validate_reference_image(job, work_dir) if input['mode'] == 'image-to-video' else None
    path = work_dir / f"sns_studio_{job['jobId']}_{input['modelName']}.mp4"
    gpu = check_gpu_environment()
    model = SUPPORTED_MODELS[input['modelName']]
    if not is_mock:
        if not gpu['cuda_available'] or gpu['vram_gb'] < model['min_vram_gb']:
            raise RuntimeError('BLOCKED_BY_GPU')
        if gpu['ram_free_gb'] is None or gpu['ram_free_gb'] < model['min_ram_free_gb'] or gpu['disk_free_gb'] < model['min_disk_free_gb']:
            raise RuntimeError('BLOCKED_BY_RAM_OR_DISK')
        verify_runtime_versions()
    if is_mock:
        generate_mock_video(path, width=input['adopted']['width'], height=input['adopted']['height'], duration_seconds=input['durationSeconds'], fps=input['adopted']['fps'])
        execution = {}
    else:
        execution = run_oss_pipeline(input, path, image, job.get('cancelCheck'))
    video = validate_video(path)
    if not is_mock and (video['width'], video['height'], video['numFrames']) != (input['adopted']['width'], input['adopted']['height'], input['adopted']['numFrames']):
        raise ValueError('MODEL_OUTPUT_CONTRACT_MISMATCH')
    evidence = dict(mock=is_mock, realInference=not is_mock, modelName=input['modelName'], mode=input['mode'], repoId=model['repo_id'], revision=model['revision'], pipeline=model['pipeline_class'], adopted=input['adopted'], requestedDurationSeconds=input['durationSeconds'], seed=input['seed'], gpu=gpu, python=sys.version.split()[0], versions=runtime_versions(), referenceImageSha256=input.get('referenceImage', {}).get('sha256'), executionSeconds=time.monotonic()-execution_start, **execution, output=video)
    (work_dir / 'generation-evidence.json').write_text(json.dumps(evidence, indent=2))
    return [str(path)]
