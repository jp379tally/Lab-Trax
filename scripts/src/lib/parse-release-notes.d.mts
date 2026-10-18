export function extractVersionBlock(raw: string, version: string): string | null;
export function parseReleaseNotes(
  filePath: string,
  version: string,
): Promise<string | null>;
