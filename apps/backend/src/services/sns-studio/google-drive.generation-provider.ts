import { Injectable } from '@nestjs/common';
import { GoogleDriveStorageProvider } from './google-drive.storage';
import { GenerationJobManifest, GenerationProvider } from './generation-provider.interface';
import { generationInputHash } from './generation-manifest';

@Injectable()
export class GoogleDriveGenerationProvider implements GenerationProvider {
  constructor(private readonly storage: GoogleDriveStorageProvider) {}

  async submit(manifest: GenerationJobManifest, image?: { data: Buffer; mimeType: string; sha256: string }) {
    const attempt = manifest.attempt || 1;
    const folder = await this.storage.createJobFolder(manifest.organizationId, `SNSStudio_job_${manifest.jobId}_a${attempt}`);
    if (!folder.id) throw new Error('GOOGLE_DRIVE_JOB_UPLOAD_FAILED');
    const [lockFileId, outputFileId, resultFileId] = await this.storage.reserveGenerationIds(manifest.organizationId);
    const { outputFolderId, ...input } = manifest.input;
    if (image) {
      const uploaded = await this.storage.uploadGenerationImage(manifest.organizationId, folder.id, image.data, image.mimeType);
      if (!uploaded.id || Number(uploaded.size) !== image.data.length || uploaded.mimeType !== image.mimeType) throw new Error('GENERATION_IMAGE_UPLOAD_FAILED');
      input.referenceImage = { fileId: uploaded.id, sha256: image.sha256, sizeBytes: image.data.length, mimeType: image.mimeType };
    }
    const inputHash = generationInputHash(input);
    const control = await this.storage.uploadJson(manifest.organizationId, 'control.json', { jobId: manifest.jobId, attempt, cancelRequested: false }, folder.id);
    if (!control.id) throw new Error('GOOGLE_DRIVE_CONTROL_UPLOAD_FAILED');
    const execution = { attempt, inputHash, lockFileId, outputFileId, resultFileId, controlFileId: control.id, jobFolderId: folder.id };
    const file = await this.storage.uploadJson(
      manifest.organizationId,
      'job.json',
      { ...manifest, schemaVersion: 2, ...execution, outputFolderId, input },
      folder.id,
    );
    if (!file.id || !folder.id) throw new Error('GOOGLE_DRIVE_JOB_UPLOAD_FAILED');
    return { queuePath: folder.id, url: folder.webViewLink, input, execution: { ...execution, manifestFileId: file.id } };
  }
}
