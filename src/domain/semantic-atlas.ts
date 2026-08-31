export interface SemanticAtlasInstallation {
  installed: boolean;
}

export interface SemanticAtlasClient {
  readInstallation(): Promise<SemanticAtlasInstallation>;
  listActionableBusinessDomains(repositoryPath: string): Promise<readonly string[]>;
}
