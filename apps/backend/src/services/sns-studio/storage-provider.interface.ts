export type SnsDriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string | null;
  createdTime?: string | null;
  modifiedTime?: string | null;
  webViewLink?: string | null;
};

export interface StorageProvider {
  listFolders(organizationId: string): Promise<Array<Pick<SnsDriveFile, 'id' | 'name'>>>;
  listMedia(organizationId: string, folderId: string): Promise<SnsDriveFile[]>;
  download(organizationId: string, fileId: string, destination: string): Promise<void>;
}
