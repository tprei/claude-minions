export interface GithubRemote {
  owner: string;
  repo: string;
}

export function parseGithubRemote(remoteUrl: string): GithubRemote | null {
  const httpsMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (httpsMatch) {
    const owner = httpsMatch[1];
    const repo = httpsMatch[2];
    if (owner && repo) {
      return { owner, repo };
    }
  }
  return null;
}
