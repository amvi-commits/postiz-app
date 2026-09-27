import { Injectable } from '@nestjs/common';
import { GoogleDriveStorageProvider } from './google-drive.storage';
import { GenerationJobManifest, GenerationProvider } from './generation-provider.interface';

@Injectable()
export class GoogleDriveGenerationProvider implements GenerationProvider {
  constructor(private readonly storage: GoogleDriveStorageProvider) {}

  async submit(manifest: GenerationJobManifest) {
    const folder = await this.storage.createJobFolder(manifest.organizationId, `SNSStudio_job_${manifest.jobId}`);
    const file = await this.storage.uploadJson(
      manifest.organizationId,
      'job.json',
      { ...manifest, input: { ...manifest.input, jobFolderId: folder.id } },
      folder.id,
    );
    if (!file.id || !folder.id) throw new Error('GOOGLE_DRIVE_JOB_UPLOAD_FAILED');
    return { queuePath: folder.id, url: folder.webViewLink };
  }
}
