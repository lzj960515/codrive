import type { Project } from "./types.js";

export interface LocalProject {
  name: string;
  rootPaths: string[];
}

export type LocalProjectList =
  | { available: true; projects: LocalProject[] }
  | { available: false; projects: []; reason: string };

export interface LocalProjectCatalog {
  read(): Promise<LocalProjectList>;
}

export interface CodriveProjectIdentity {
  id: string;
  name: string;
  repositoryPath: string;
  status: Project["status"];
  scheduling: Project["scheduling"];
  archivedAt: string | null;
}
