import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

export interface SecretStore {
  getSecret(ref: string): Promise<string | null>;
  setSecret(ref: string, value: string): Promise<void>;
  deleteSecret(ref: string): Promise<void>;
  healthCheck(): Promise<{ available: boolean }>;
}

export class LocalEncryptedSecretStore implements SecretStore {
  private key(): Buffer {
    const encoded = process.env.ACCOUNT_SECRET_ENCRYPTION_KEY;
    if (!encoded) throw new Error('ACCOUNT_SECRET_ENCRYPTION_KEY is required for local secret storage');
    const value = Buffer.from(encoded, 'base64');
    if (value.length !== 32 || value.toString('base64') !== encoded) throw new Error('ACCOUNT_SECRET_ENCRYPTION_KEY must be a base64 encoded 32-byte key');
    return value;
  }
  private validateRef(ref: string) {
    if (!ref || ref.length > 256) throw new Error('Secret reference is invalid');
  }
  private path() { return process.env.ACCOUNT_SECRET_STORE_PATH || join(process.env.SNS_STUDIO_DATA_DIR || '.sns-studio-data', 'account-secrets.json'); }
  private async read(): Promise<Record<string, { iv: string; tag: string; data: string }>> {
    try { return JSON.parse(await readFile(this.path(), 'utf8')); } catch (error) { if ((error as any).code === 'ENOENT') return {}; throw new Error('Local secret store is unreadable'); }
  }
  async getSecret(ref: string) {
    this.validateRef(ref);
    const key = this.key();
    const value = (await this.read())[ref]; if (!value) return null;
    try { const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64')); decipher.setAuthTag(Buffer.from(value.tag, 'base64')); return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'); }
    catch { throw new Error('Stored secret could not be authenticated'); }
  }
  async setSecret(ref: string, secret: string) {
    this.validateRef(ref);
    const key = this.key(), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const values = await this.read(); values[ref] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
    const path = this.path(); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(values), { mode: 0o600 }); await rename(temp, path);
  }
  async deleteSecret(ref: string) {
    this.validateRef(ref); this.key();
    const values = await this.read(); delete values[ref];
    const path = this.path(); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(values), { mode: 0o600 }); await rename(temp, path);
  }
  async healthCheck() { try { this.key(); await this.read(); return { available: true }; } catch { return { available: false }; } }
}
