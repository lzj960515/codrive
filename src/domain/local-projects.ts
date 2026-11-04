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
