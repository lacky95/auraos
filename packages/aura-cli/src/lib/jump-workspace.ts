export function jumpWorkspace(manifest: { metadata?: Record<string, unknown> }): string | undefined {
  if (manifest.metadata?.['kind'] !== 'devbox-v1') return undefined;
  const workspace = manifest.metadata?.['dev-workspace'] as { folder?: unknown } | undefined;
  const folder = workspace?.folder;
  if (typeof folder !== 'string' || !folder.startsWith('/data/') || /[\x00-\x1f\\]/.test(folder)
    || folder.split('/').some(part => part === '..' || part === '.')) return undefined;
  return folder;
}
