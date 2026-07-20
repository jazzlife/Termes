export function dashboardWorkspacePath(hostPath: string, accountId: string): string {
  const accountRoot = `/data/docker_data/termes/workspaces/users/${accountId}`;
  if (hostPath !== accountRoot && !hostPath.startsWith(`${accountRoot}/`)) {
    throw new Error(`Project workspace is outside the account workspace root: ${hostPath}`);
  }
  return `/workspace${hostPath.slice(accountRoot.length)}`;
}
