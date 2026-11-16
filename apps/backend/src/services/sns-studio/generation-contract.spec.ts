import { validateGenerationInput, generationModels } from '@gitroom/helpers/video-generation/contract';
import { generationInputHash } from './generation-manifest';

describe('B-mode bounded request contract (no real model inference)', () => {
  it('keeps seed zero and exposes model grid adjustments and exact revision', () => {
    const input = validateGenerationInput({ prompt: 'A mug', seed: 0, durationSeconds: 3 });
    expect(input.seed).toBe(0);
    expect(input.adopted).toMatchObject({ width: 480, height: 848, numFrames: 49, fps: 16 });
    expect(input.adopted.revision).toMatch(/^[a-f0-9]{40}$/);
    for (const modelName of Object.keys(generationModels)) {
      const model = generationModels[modelName];
      const result = validateGenerationInput({ prompt: 'A mug', modelName, mode: model.modes[0], ...(model.modes[0] === 'image-to-video' ? { referenceImageAssetId: 'own-image' } : {}) });
      expect((result.adopted.numFrames - 1) % model.frame_stride).toBe(0);
      expect(result.adopted.width % model.spatial_stride).toBe(0);
      expect(result.adopted.height % model.spatial_stride).toBe(0);
    }
  });
  it.each([{ modelName: 'unknown' }, { modelName: '' }, { modelName: 'wan-2.1-t2v-1.3b', mode: 'image-to-video', referenceImageAssetId: 'own-image' }, { mock: 'false' }, { mock: true }, { seed: '0' }, { seed: -1 }, { seed: true }, { durationSeconds: 5 }, { durationSeconds: 0 }, { durationSeconds: '3' }, { count: 2 }, { numInferenceSteps: 51 }, { resolution: '720p' }, { referenceImage: '/etc/passwd' }, { _generation: { attempt: 2 } }])('rejects invalid/untrusted input: %j', extra => {
    expect(() => validateGenerationInput({ prompt: 'A mug', ...extra })).toThrow('GENERATION_INPUT_INVALID');
  });
  it('distinguishes absent model from an explicit wrong model and requires org asset ID for I2V', () => {
    expect(validateGenerationInput({ prompt: 'A mug', mode: 'image-to-video', referenceImageAssetId: 'own-image' }).modelName).toBe('ltx-video-0.9.1-i2v');
    expect(() => validateGenerationInput({ prompt: 'A mug', mode: 'image-to-video' })).toThrow();
  });
  it('hashes canonical JSON independently of key order', () => {
    expect(generationInputHash({ z: 0, a: 'マグ' })).toBe(generationInputHash({ a: 'マグ', z: 0 }));
  });
});
