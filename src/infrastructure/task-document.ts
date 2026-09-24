import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { WorkflowConflictError } from "../domain/errors.js";

export function resolveTaskDocumentPath(
  repositoryPath: string,
  taskDocumentPath: string,
): string {
  const sourcePath = taskDocumentPath.trim();
  const repositoryRoot = resolve(repositoryPath);
  const documentFile = resolve(repositoryRoot, sourcePath);
  const repositoryRelativePath = relative(repositoryRoot, documentFile);
  if (
    !sourcePath ||
    isAbsolute(sourcePath) ||
    !repositoryRelativePath ||
    repositoryRelativePath === ".." ||
    repositoryRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(repositoryRelativePath)
  ) {
    throw new WorkflowConflictError(
      "Task document path must identify a file inside the project repository",
    );
  }
  return documentFile;
}

export async function readTaskDocument(
  repositoryPath: string,
  taskDocumentPath: string,
): Promise<string> {
  const documentFile = resolveTaskDocumentPath(
    repositoryPath,
    taskDocumentPath,
  );
  let document: string;
  try {
    document = await readFile(documentFile, "utf8");
  } catch {
    throw new WorkflowConflictError(
      `Task document cannot be read: ${taskDocumentPath}`,
    );
  }
  if (!document.trim()) {
    throw new WorkflowConflictError(
      `Task document is empty: ${taskDocumentPath}`,
    );
  }
  return document;
}
