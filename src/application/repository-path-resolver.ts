export interface RepositoryPathResolver {
  resolveWorkspaceRepository(workspacePath: string): Promise<string>;
}
