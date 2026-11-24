/**
 * `frame-ancestors` for the shell's own documents, or null to leave a response
 * alone. No app document is served on the shell's origin, and nothing frames
 * the desktop, so its pages may not be framed at all. Login and setup send the
 * same `'none'` themselves.
 */
export const SHELL_FRAME_ANCESTORS = "frame-ancestors 'none'";

export function shellFramePolicy(pathname: string, contentType: string | null, existingCsp: string | null): string | null {
  if (existingCsp) return null;
  if (pathname === '/api' || pathname.startsWith('/api/')) return null;
  if (!contentType || !/^text\/html\b/i.test(contentType)) return null;
  return SHELL_FRAME_ANCESTORS;
}
