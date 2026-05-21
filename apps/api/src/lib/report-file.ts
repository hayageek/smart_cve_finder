import { readArtifactText } from './artifact-files.js';

export async function readReportMarkdown(
  findingId: string,
  reportPath: string | null,
): Promise<string | null> {
  return readArtifactText(findingId, 'report.md', reportPath);
}
