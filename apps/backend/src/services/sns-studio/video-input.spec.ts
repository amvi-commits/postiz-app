import { registerVideoInput } from './video-input';
import { realpathSync, statSync } from 'fs';
import { resolve } from 'path';
jest.mock('fs', () => ({ realpathSync: jest.fn(), statSync: jest.fn() }));

describe('Video Tools Postiz input bridge', () => {
  const root = resolve('test-uploads');
  let service: any, prisma: any, probe: jest.Mock;
  beforeEach(() => {
    process.env.UPLOAD_DIRECTORY = root;
    process.env.FRONTEND_URL = 'http://localhost:4017';
    (realpathSync as unknown as jest.Mock).mockImplementation((path) => path);
    (statSync as jest.Mock).mockReturnValue({ size: 1234, isFile: () => true });
    service = { getMediaStatus: jest.fn().mockResolvedValue({ id: 'media-1', name: 'random.mp4', originalName: 'source.mp4', path: 'http://localhost:4017/uploads/test.mp4', status: 'ready' }) };
    const tx = { snsMediaAsset: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(async ({ data }) => ({ id: 'asset-1', ...data })) } };
    prisma = { ...tx, $transaction: jest.fn(async (fn) => fn(tx)) };
    probe = jest.fn().mockResolvedValue({ kind: 'video', sizeBytes: 1234, durationSeconds: 2, video: { width: 1080, height: 1920 } });
  });
  afterEach(() => { delete process.env.UPLOAD_DIRECTORY; delete process.env.FRONTEND_URL; });
  it('registers an org-owned asset with measured metadata and Postiz ID', async () => {
    const asset = await registerVideoInput(prisma, service, 'group', 'media-1', probe);
    expect(service.getMediaStatus).toHaveBeenCalledWith('group', 'media-1');
    expect(asset).toMatchObject({ storageKey: '/uploads/test.mp4', fileName: 'source.mp4', sizeBytes: '1234', duration: 2, postizMediaId: 'media-1' });
    expect(prisma.snsMediaAsset.create).toHaveBeenCalledWith({ data: expect.objectContaining({ organizationId: 'group', metadata: { postizMediaId: 'media-1' } }) });
    expect(probe).toHaveBeenCalledWith('/uploads/test.mp4');
  });
  it('reuses an existing org-owned asset', async () => {
    prisma.snsMediaAsset.findFirst.mockResolvedValue({ id: 'existing', fileName: 'old.mp4', storageKey: '/uploads/test.mp4' });
    expect((await registerVideoInput(prisma, service, 'group', 'media-1', probe)).id).toBe('existing');
    expect(prisma.snsMediaAsset.findFirst).toHaveBeenCalledWith({ where: { organizationId: 'group', storageKey: '/uploads/test.mp4' } });
    expect(prisma.snsMediaAsset.create).not.toHaveBeenCalled();
  });
  it('rejects another organization before any file access or worker request', async () => {
    service.getMediaStatus.mockRejectedValue(new Error('Not found'));
    await expect(registerVideoInput(prisma, service, 'other', 'media-1', probe)).rejects.toMatchObject({ status: 404 });
    expect(probe).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each(['processing', 'failed'])('rejects %s media', async (status) => {
    service.getMediaStatus.mockResolvedValue({ status });
    await expect(registerVideoInput(prisma, service, 'group', 'm', probe)).rejects.toMatchObject({ status: 422 });
    expect(probe).not.toHaveBeenCalled();
  });
  it.each(['https://other.example/uploads/a.mp4', '/uploads/a.jpg', '/uploads/../../secret.mp4'])('rejects unsupported or escaping path %s', async (path) => {
    service.getMediaStatus.mockResolvedValue({ path, status: 'ready' });
    await expect(registerVideoInput(prisma, service, 'group', 'm', probe)).rejects.toBeDefined();
    expect(probe).not.toHaveBeenCalled();
  });
  it('rejects missing, empty or mismatched shared files without creating an asset', async () => {
    probe.mockResolvedValue({ kind: 'video', sizeBytes: 99, durationSeconds: 2, video: {} });
    await expect(registerVideoInput(prisma, service, 'group', 'm', probe)).rejects.toMatchObject({ status: 422 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('retries only a serialization conflict, never an upload or provider action', async () => {
    prisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });
    await registerVideoInput(prisma, service, 'group', 'm', probe);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
