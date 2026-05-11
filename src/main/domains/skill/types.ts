export type SkillRecord = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  isOfficial: boolean;
  isBuiltIn: boolean;
  updatedAt: number;
  prompt: string;
  skillPath: string;
  version?: string;
};

export type SkillStateMap = Record<string, { enabled: boolean }>;

export type EmailConnectivityCheckCode = 'imap_connection' | 'smtp_connection';
export type EmailConnectivityCheckLevel = 'pass' | 'fail';
export type EmailConnectivityVerdict = 'pass' | 'fail';

export type EmailConnectivityCheck = {
  code: EmailConnectivityCheckCode;
  level: EmailConnectivityCheckLevel;
  message: string;
  durationMs: number;
};

export type EmailConnectivityTestResult = {
  testedAt: number;
  verdict: EmailConnectivityVerdict;
  checks: EmailConnectivityCheck[];
};

export type SkillDefaultConfig = {
  order?: number;
  enabled?: boolean;
};

export type SkillsConfig = {
  version: number;
  description?: string;
  defaults: Record<string, SkillDefaultConfig>;
};

export type SkillScriptRunResult = {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
  spawnErrorCode?: string;
};

export type NormalizedGitSource = {
  repoUrl: string;
  sourceSubpath?: string;
  ref?: string;
  repoNameHint?: string;
};

export type GithubRepoSource = {
  owner: string;
  repo: string;
};
