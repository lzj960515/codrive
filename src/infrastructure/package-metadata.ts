import { readFile } from "node:fs/promises";

export async function readPackageVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return packageJson.version;
}
