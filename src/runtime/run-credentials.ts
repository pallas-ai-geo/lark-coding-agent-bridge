export interface RunCredentials {
  env: Readonly<Record<string, string>>;
  removeEnvKeys: readonly string[];
  dispose(): Promise<void>;
  onLost(listener: () => void): () => void;
}

export type RunCredentialFactory = (runId: string) => Promise<RunCredentials>;
