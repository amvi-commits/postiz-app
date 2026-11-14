export type GenerationJobManifest = {
  jobId: string;
  organizationId: string;
  createdAt: string;
  input: Record<string, unknown>;
  resultFilePrefix: string;
  attempt?: number;
};

export interface GenerationProvider {
  submit(manifest: GenerationJobManifest): Promise<{ queuePath: string; url?: string | null; input?: Record<string, unknown>; execution?: Record<string, unknown> }>;
}
