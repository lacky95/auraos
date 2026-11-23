export function stripSessionCookie(value: string): string | null;
export function stripShellCredentials<T>(headers: T, surface: string): T;
export function dropServiceWorkerScope(response: Response): Response;
