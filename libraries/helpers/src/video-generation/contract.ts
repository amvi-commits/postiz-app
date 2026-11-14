// Shared with the standalone Colab adapter; no model weights or credentials.
import modelContract from '../../../../services/colab/model-contract.json';

const contract = modelContract as {
  schemaVersion: number;
  limits: Record<string, number>;
  models: Record<string, { repo_id: string; revision: string; pipeline_class: string; modes: string[]; fps: number; frame_stride: number; spatial_stride: number; sizes: Record<string, number[]> }>;
  aliases: Record<string, string>;
};
export const generationModels = contract.models;
export const generationLimits = contract.limits;
export function validateGenerationInput(raw: unknown, allowMock = false): Record<string, any> {
  const fail = (field: string): never => { throw new Error(`GENERATION_INPUT_INVALID:${field}`); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('input');
  const input = raw as Record<string, any>;
  const allowed = ['mode', 'modelName', 'prompt', 'negativePrompt', 'durationSeconds', 'resolution', 'aspectRatio', 'seed', 'numInferenceSteps', 'count', 'mock', 'referenceImageAssetId'];
  if (Object.keys(input).some(key => !allowed.includes(key))) fail('unsupported_field');
  if ('mock' in input && typeof input.mock !== 'boolean') fail('mock');
  if (input.mock === true && !allowMock) fail('mock_disabled');
  const mode = input.mode === undefined ? 'text-to-video' : input.mode;
  if (!['text-to-video', 'image-to-video'].includes(mode)) fail('mode');
  const rawModel = input.modelName === undefined ? (mode === 'text-to-video' ? 'wan-2.1-t2v-1.3b' : 'ltx-video-0.9.1-i2v') : input.modelName;
  if (typeof rawModel !== 'string' || !rawModel) fail('modelName');
  const modelName = contract.aliases[rawModel] || rawModel;
  const model = Object.prototype.hasOwnProperty.call(contract.models, modelName) ? contract.models[modelName] : undefined;
  if (!model || !model.modes.includes(mode)) fail('model_mode');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > contract.limits.prompt) fail('prompt');
  if (input.negativePrompt !== undefined && (typeof input.negativePrompt !== 'string' || input.negativePrompt.length > contract.limits.negativePrompt)) fail('negativePrompt');
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = input[key] === undefined ? fallback : input[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(key);
    return value;
  };
  const durationSeconds = integer('durationSeconds', 3, contract.limits.durationMin, contract.limits.durationMax);
  const numInferenceSteps = integer('numInferenceSteps', 30, 1, 50);
  const seed = integer('seed', 0, 0, 4294967295);
  integer('count', 1, 1, 1);
  const resolution = input.resolution === undefined ? '480p' : input.resolution;
  const aspectRatio = input.aspectRatio === undefined ? '9:16' : input.aspectRatio;
  if (resolution !== '480p') fail('resolution');
  if (typeof aspectRatio !== 'string' || !Object.prototype.hasOwnProperty.call(model.sizes, aspectRatio)) fail('aspectRatio');
  if (mode === 'image-to-video' && (typeof input.referenceImageAssetId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.referenceImageAssetId))) fail('referenceImageAssetId');
  if (mode === 'text-to-video' && input.referenceImageAssetId !== undefined) fail('referenceImageAssetId');
  const [width, height] = model.sizes[aspectRatio];
  const numFrames = Math.round((durationSeconds * model.fps - 1) / model.frame_stride) * model.frame_stride + 1;
  return { mode, modelName, prompt: input.prompt.trim(), negativePrompt: input.negativePrompt || '', durationSeconds, resolution, aspectRatio, numInferenceSteps, seed, count: 1, mock: input.mock === true,
    ...(mode === 'image-to-video' ? { referenceImageAssetId: input.referenceImageAssetId } : {}),
    adopted: { width, height, fps: model.fps, numFrames, durationSeconds: numFrames / model.fps, reasons: ['Dimensions use the model spatial grid; frames use its temporal grid.'], repoId: model.repo_id, revision: model.revision, pipeline: model.pipeline_class } };
}
