export interface SemanticAtlasInstallation {
  installed: boolean;
}

export interface SemanticAtlasClient {
  readInstallation(): Promise<SemanticAtlasInstallation>;
  maintenanceRequired(repositoryPath: string): Promise<boolean>;
}
