"""One finite child invocation; no network service or persistent queue consumer."""
import json
import sys
from pathlib import Path
from sns_studio_model_adapter import generate, check_gpu_environment, runtime_versions

if __name__ == '__main__':
    manifest, directory = map(Path, sys.argv[1:])
    job = json.loads(manifest.read_text())
    try:
        generate(job, str(directory))
    except Exception as error:
        code = 'MODEL_OUT_OF_MEMORY' if 'OutOfMemory' in type(error).__name__ else 'MODEL_INFERENCE_FAILED'
        diagnostic = dict(errorCode=code, exceptionType=type(error).__name__, jobId=job.get('jobId'), mode=job.get('input', {}).get('mode'), modelName=job.get('input', {}).get('modelName'), gpu=check_gpu_environment(), versions=runtime_versions())
        try:
            import torch
            if torch.cuda.is_available():
                diagnostic.update(peakGpuMemoryBytes=torch.cuda.max_memory_allocated(), peakGpuReservedBytes=torch.cuda.max_memory_reserved())
        except ImportError:
            pass
        (directory / 'failure-evidence.json').write_text(json.dumps(diagnostic, indent=2))
        print(code)
        sys.exit(1)
