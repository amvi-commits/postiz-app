import { HttpException } from '@nestjs/common';
import { realpathSync, statSync } from 'fs';
import { resolve, sep } from 'path';
import type { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import type { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';

// Only the server-owned Media row resolves a path. Never accept a client path/URL.
export async function registerVideoInput(
  prisma: PrismaService, mediaService: MediaService, orgId: string, mediaId: string,
  probe: (path: string) => Promise<any>,
) {
  const media = await mediaService.getMediaStatus(orgId, mediaId).catch(() => null);
  if (!media) throw new HttpException({ code: 'MEDIA_NOT_FOUND' }, 404);
  if (media.status && media.status !== 'ready') {
    throw new HttpException({ code: 'MEDIA_NOT_READY' }, 422);
  }
  let storageKey = media.path;
  if (!storageKey.startsWith('/uploads/')) {
    try {
      const url = new URL(storageKey);
      if (url.origin !== new URL(process.env.FRONTEND_URL || '').origin || url.search || url.hash) throw new Error();
      storageKey = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpException({ code: 'VIDEO_INPUT_LOCAL_MEDIA_REQUIRED', message: '現在のVideo Toolsでは、この環境に保存されたMP4を選択してください。' }, 422);
    }
  }
  if (!storageKey.startsWith('/uploads/') || !storageKey.toLowerCase().endsWith('.mp4') || /[\\\0?#]/.test(storageKey)) {
    throw new HttpException({ code: 'VIDEO_INPUT_MP4_REQUIRED' }, 422);
  }
  let size: number;
  try {
    const root = realpathSync(resolve(process.env.UPLOAD_DIRECTORY || './uploads'));
    const path = realpathSync(resolve(root, storageKey.slice('/uploads/'.length)));
    const stat = statSync(path);
    if (!path.startsWith(`${root}${sep}`) || !stat.isFile() || stat.size <= 0) throw new Error();
    size = stat.size;
  } catch {
    throw new HttpException({ code: 'MEDIA_FILE_NOT_FOUND' }, 404);
  }
  const info = await probe(storageKey);
  if (info.kind !== 'video' || !info.video || !(info.durationSeconds > 0) || Number(info.sizeBytes) !== size) {
    throw new HttpException({ code: 'VIDEO_INPUT_PROBE_FAILED' }, 422);
  }
  // Serializable find/create makes repeated selections reuse the same org-owned asset.
  for (let attempt = 0; ; attempt++) {
    try {
      const asset = await prisma.$transaction(async (tx) => {
        const existing = await tx.snsMediaAsset.findFirst({ where: { organizationId: orgId, storageKey } });
        if (existing) return existing;
        return tx.snsMediaAsset.create({ data: {
          organizationId: orgId, source: 'POSTIZ_MEDIA', storageKey,
          fileName: media.originalName || media.name, mimeType: 'video/mp4', sizeBytes: BigInt(size),
          duration: info.durationSeconds, width: info.video.width, height: info.video.height,
          metadata: { postizMediaId: media.id },
        } });
      }, { isolationLevel: 'Serializable' });
      return { ...asset, fileName: media.originalName || asset.fileName,
        sizeBytes: size.toString(), duration: info.durationSeconds,
        postizMediaId: media.id };
    } catch (error: any) {
      if (error?.code !== 'P2034' || attempt >= 2) throw error;
    }
  }
}
