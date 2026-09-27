import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'crypto';
import { createWriteStream, mkdirSync, chmodSync, openSync, closeSync, writeFileSync, readFileSync, renameSync, unlinkSync, copyFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { SnsDriveFile, StorageProvider } from './storage-provider.interface';

const TOKEN_SETTING = 'google-drive:encrypted-token';
const STATE_SETTING = 'google-drive:oauth-state';
const FOLDER_SETTING = 'google-drive:inbox-folder';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

@Injectable()
export class GoogleDriveStorageProvider implements StorageProvider {
  constructor(private readonly prisma: PrismaService) {}

  private mockEnabled() {
    return ['1', 'true', 'yes'].includes((process.env.SNS_STUDIO_GOOGLE_DRIVE_MOCK || '').toLowerCase());
  }

  private mockRoot() {
    return resolve(process.env.SNS_STUDIO_MOCK_DRIVE_DIRECTORY || join(process.env.UPLOAD_DIRECTORY || './uploads', 'sns-studio', 'mock-drive'));
  }

  private ensureMockDirectory(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o777 });
    // Postiz and the mock worker use different UIDs but share this local-only test volume.
    chmodSync(directory, 0o777);
    return directory;
  }

  private mockFileId(filePath: string) {
    return `mockdrive:${relative(this.mockRoot(), filePath).split(sep).join('/')}`;
  }

  private mockPath(fileId: string) {
    if (!fileId.startsWith('mockdrive:')) throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_FILE_INVALID' });
    const root = this.mockRoot();
    const filePath = resolve(root, fileId.slice('mockdrive:'.length));
    if (!filePath.startsWith(`${root}${sep}`)) throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_FILE_INVALID' });
    return filePath;
  }

  private mockMimeType(fileName: string) {
    const extension = extname(fileName).toLowerCase();
    return ({
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
      '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    } as Record<string, string>)[extension] || 'application/octet-stream';
  }

  private config() {
    const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_OAUTH_NOT_CONFIGURED' });
    }
    return { clientId, clientSecret, redirectUri };
  }

  private oauthClient() {
    const { clientId, clientSecret, redirectUri } = this.config();
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  private async setting(organizationId: string, key: string) {
    return this.prisma.snsAppSetting.findUnique({ where: { organizationId_key: { organizationId, key } } });
  }

  private saveSetting(organizationId: string, key: string, value: unknown) {
    return this.prisma.snsAppSetting.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, value: value as any },
      update: { value: value as any },
    });
  }

  async authorizationUrl(organizationId: string) {
    const state = randomBytes(32).toString('base64url');
    await this.saveSetting(organizationId, STATE_SETTING, { state, expiresAt: Date.now() + 10 * 60_000 });
    if (this.mockEnabled()) {
      const baseUrl = (process.env.MAIN_URL || 'http://localhost:4007').replace(/\/$/, '');
      return `${baseUrl}/api/sns-studio/drive/callback?code=local-mock&state=${encodeURIComponent(state)}`;
    }
    return this.oauthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      state,
      scope: [DRIVE_SCOPE],
    });
  }

  async completeAuthorization(organizationId: string, code: string, state: string) {
    const stateSetting = await this.setting(organizationId, STATE_SETTING);
    const saved = stateSetting?.value as { state?: string; expiresAt?: number } | undefined;
    if (!saved?.state || saved.state !== state || !saved.expiresAt || saved.expiresAt < Date.now()) {
      throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_OAUTH_STATE_INVALID' });
    }
    if (this.mockEnabled()) {
      if (code !== 'local-mock') throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_OAUTH_RESPONSE_INVALID' });
      await this.saveSetting(organizationId, TOKEN_SETTING, 'local-mock-drive');
      await this.prisma.snsAppSetting.deleteMany({ where: { organizationId, key: STATE_SETTING } });
      return { connected: true, mock: true };
    }
    const client = this.oauthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token) {
      throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_OAUTH_TOKEN_MISSING' });
    }
    await this.saveSetting(organizationId, TOKEN_SETTING, this.encrypt(organizationId, JSON.stringify(tokens)));
    await this.prisma.snsAppSetting.deleteMany({ where: { organizationId, key: STATE_SETTING } });
    return { connected: true };
  }

  async isConnected(organizationId: string) {
    if (this.mockEnabled()) return true;
    return !!(await this.setting(organizationId, TOKEN_SETTING));
  }

  private dataDirectory() {
    return resolve(process.env.SNS_STUDIO_DATA_DIR || '.sns-studio-data');
  }

  private encryptionKey() {
    const fromEnv = process.env.GOOGLE_DRIVE_TOKEN_KEY;
    if (fromEnv) {
      const key = Buffer.from(fromEnv, 'base64');
      if (key.length !== 32) throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_KEY_INVALID' });
      return key;
    }
    const directory = this.dataDirectory();
    mkdirSync(directory, { recursive: true });
    const keyPath = join(directory, '.google-drive-token.key');
    try {
      const fd = openSync(keyPath, 'wx', 0o600);
      const key = randomBytes(32);
      writeFileSync(fd, key);
      closeSync(fd);
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const key = readFileSync(keyPath);
      if (key.length !== 32) throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_KEY_INVALID' });
      return key;
    }
  }

  private encrypt(organizationId: string, plaintext: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    cipher.setAAD(Buffer.from(organizationId));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  private decrypt(organizationId: string, ciphertext: string) {
    try {
      const input = Buffer.from(ciphertext, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), input.subarray(0, 12));
      decipher.setAAD(Buffer.from(organizationId));
      decipher.setAuthTag(input.subarray(12, 28));
      return Buffer.concat([decipher.update(input.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_TOKEN_DECRYPT_FAILED' });
    }
  }

  private async drive(organizationId: string) {
    const saved = await this.setting(organizationId, TOKEN_SETTING);
    if (!saved || typeof saved.value !== 'string') {
      throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_NOT_CONNECTED' });
    }
    const client = this.oauthClient();
    const credentials = JSON.parse(this.decrypt(organizationId, saved.value));
    client.setCredentials(credentials);
    client.on('tokens', async (tokens) => {
      const updated = { ...credentials, ...tokens, refresh_token: tokens.refresh_token || credentials.refresh_token };
      try {
        await this.saveSetting(organizationId, TOKEN_SETTING, this.encrypt(organizationId, JSON.stringify(updated)));
      } catch {
        // Token refresh remains usable for this request; the next call will ask the user to reconnect if needed.
      }
    });
    return google.drive({ version: 'v3', auth: client });
  }

  async listFolders(organizationId: string) {
    if (this.mockEnabled()) {
      this.ensureMockDirectory(this.mockRoot());
      this.ensureMockDirectory(join(this.mockRoot(), 'inbox'));
      this.ensureMockDirectory(join(this.mockRoot(), 'jobs'));
      this.ensureMockDirectory(join(this.mockRoot(), 'results'));
      return [{ id: 'mockdrive:root', name: 'SNS Studio Local Mock Drive' }];
    }
    const drive = await this.drive(organizationId);
    const result: Array<{ id: string; name: string }> = [];
    let pageToken: string | undefined;
    do {
      const response = await drive.files.list({
        q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields: 'nextPageToken,files(id,name)',
        pageSize: 1000,
        pageToken,
        orderBy: 'name',
      });
      for (const file of response.data.files || []) if (file.id && file.name) result.push({ id: file.id, name: file.name });
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);
    return result;
  }

  async selectedFolder(organizationId: string) {
    const saved = await this.setting(organizationId, FOLDER_SETTING);
    if (saved?.value) return saved.value as { id?: string; name?: string };
    if (this.mockEnabled()) return { id: 'mockdrive:root', name: 'SNS Studio Local Mock Drive' };
    return null;
  }

  async selectFolder(organizationId: string, folderId: string) {
    if (this.mockEnabled()) {
      if (folderId !== 'mockdrive:root') throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_FOLDER_INVALID' });
      const folder = { id: 'mockdrive:root', name: 'SNS Studio Local Mock Drive' };
      await this.saveSetting(organizationId, FOLDER_SETTING, folder);
      return folder;
    }
    const drive = await this.drive(organizationId);
    const result = await drive.files.get({ fileId: folderId, fields: 'id,name,mimeType,trashed' });
    if (result.data.mimeType !== 'application/vnd.google-apps.folder' || result.data.trashed) {
      throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_FOLDER_INVALID' });
    }
    await this.saveSetting(organizationId, FOLDER_SETTING, { id: result.data.id, name: result.data.name });
    return { id: result.data.id, name: result.data.name };
  }

  async listMedia(organizationId: string, folderId: string): Promise<SnsDriveFile[]> {
    if (this.mockEnabled()) {
      if (folderId !== 'mockdrive:root') throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_FOLDER_INVALID' });
      const inbox = join(this.mockRoot(), 'inbox');
      mkdirSync(inbox, { recursive: true });
      return readdirSync(inbox, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const filePath = join(inbox, entry.name);
          const details = statSync(filePath);
          return {
            id: this.mockFileId(filePath),
            name: entry.name,
            mimeType: this.mockMimeType(entry.name),
            size: String(details.size),
            createdTime: details.birthtime.toISOString(),
            modifiedTime: details.mtime.toISOString(),
          };
        })
        .filter((file) => file.mimeType.startsWith('image/') || file.mimeType.startsWith('video/'));
    }
    const drive = await this.drive(organizationId);
    const files: SnsDriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const response = await drive.files.list({
        q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false and (mimeType contains 'image/' or mimeType contains 'video/')`,
        fields: 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink)',
        pageSize: 1000,
        pageToken,
        orderBy: 'createdTime desc',
      });
      files.push(...(response.data.files || []).filter((file): file is drive_v3.Schema$File & { id: string; name: string; mimeType: string } => !!file.id && !!file.name && !!file.mimeType));
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);
    return files;
  }

  async download(organizationId: string, fileId: string, destination: string) {
    if (this.mockEnabled()) {
      const source = this.mockPath(fileId);
      if (!statSync(source, { throwIfNoEntry: false })?.isFile()) throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_FILE_NOT_FOUND' });
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      return;
    }
    const drive = await this.drive(organizationId);
    const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.part`;
    try {
      await pipeline(response.data as NodeJS.ReadableStream, createWriteStream(temporary, { flags: 'wx' }));
      renameSync(temporary, destination);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* temporary file may not exist */ }
      throw error;
    }
  }

  async uploadJson(organizationId: string, fileName: string, data: unknown, parentFolderId?: string) {
    const folder = await this.selectedFolder(organizationId);
    if (!folder?.id) throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_FOLDER_REQUIRED' });
    if (this.mockEnabled()) {
      const cleanName = basename(fileName.replace(/[\\/]/g, '_')).slice(0, 160) || 'manifest.json';
      let directory: string;
      if (parentFolderId) {
        directory = parentFolderId === 'mockdrive:root' ? this.mockRoot() : this.mockPath(parentFolderId);
      } else {
        directory = join(this.mockRoot(), 'results');
      }
      this.ensureMockDirectory(directory);
      const filePath = join(directory, cleanName);
      // Local mock jobs are consumed by a separate worker container with a different UID.
      writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
      return { id: this.mockFileId(filePath), name: cleanName, webViewLink: null };
    }
    const drive = await this.drive(organizationId);
    const response = await drive.files.create({
      requestBody: { name: fileName, mimeType: 'application/json', parents: [parentFolderId || folder.id] },
      media: { mimeType: 'application/json', body: Readable.from([JSON.stringify(data)]) },
      fields: 'id,name,webViewLink',
    });
    return response.data;
  }

  async createJobFolder(organizationId: string, folderName: string) {
    const folder = await this.selectedFolder(organizationId);
    if (!folder?.id) throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_FOLDER_REQUIRED' });
    if (this.mockEnabled()) {
      const cleanName = basename(folderName.replace(/[\\/]/g, '_')).slice(0, 160) || 'SNSStudio_job';
      const folderPath = this.ensureMockDirectory(join(this.mockRoot(), 'jobs', cleanName));
      return { id: this.mockFileId(folderPath), name: cleanName, webViewLink: null };
    }
    const drive = await this.drive(organizationId);
    const response = await drive.files.create({
      requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [folder.id] },
      fields: 'id,name,webViewLink',
    });
    if (!response.data.id) throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_FOLDER_CREATE_FAILED' });
    return response.data;
  }

  async listGenerationResults(organizationId: string) {
    const folder = await this.selectedFolder(organizationId);
    if (!folder?.id) throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_FOLDER_REQUIRED' });
    if (this.mockEnabled()) {
      const results = join(this.mockRoot(), 'results');
      mkdirSync(results, { recursive: true });
      return readdirSync(results, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^sns-studio-result-.*\.json$/i.test(entry.name))
        .map((entry) => ({ id: this.mockFileId(join(results, entry.name)), name: entry.name }));
    }
    const drive = await this.drive(organizationId);
    const response = await drive.files.list({
      q: `'${folder.id.replace(/'/g, "\\'")}' in parents and trashed = false and mimeType = 'application/json' and name contains 'sns-studio-result-'`,
      fields: 'files(id,name,modifiedTime)',
      pageSize: 1000,
    });
    return response.data.files || [];
  }

  async readJson(organizationId: string, fileId: string) {
    if (this.mockEnabled()) {
      const filePath = this.mockPath(fileId);
      if (!statSync(filePath, { throwIfNoEntry: false })?.isFile()) throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_FILE_NOT_FOUND' });
      return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, any>;
    }
    const drive = await this.drive(organizationId);
    const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'json' });
    return response.data as Record<string, any>;
  }

  async fileMetadata(organizationId: string, fileId: string) {
    if (this.mockEnabled()) {
      const filePath = this.mockPath(fileId);
      const details = statSync(filePath, { throwIfNoEntry: false });
      if (!details?.isFile()) throw new ServiceUnavailableException({ code: 'GOOGLE_DRIVE_FILE_NOT_FOUND' });
      return {
        id: fileId,
        name: basename(filePath),
        mimeType: this.mockMimeType(filePath),
        size: String(details.size),
        createdTime: details.birthtime.toISOString(),
        webViewLink: null,
      };
    }
    const drive = await this.drive(organizationId);
    const response = await drive.files.get({ fileId, fields: 'id,name,mimeType,size,createdTime,webViewLink' });
    return response.data;
  }
}
