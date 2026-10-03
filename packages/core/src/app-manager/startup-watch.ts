import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function redactDiagnostic(text: string, secrets: string[] = []): string {
  for (const secret of secrets) if (secret.length > 4) text = text.split(secret).join('<REDACTED>');
  return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1<REDACTED>@')
    .replace(/((?:_authToken|authorization|password|api[_-]?key)\s*[=:]\s*)\S+/gi, '$1<REDACTED>');
}

/** Exit is a first-class startup result, not an eventual health timeout. */
export class StartupWatch {
  private tail = '';
  private controller = new AbortController();
  get signal(): AbortSignal { return this.controller.signal; }
  private resolveExit!: (error: Error) => void;
  private exited = new Promise<Error>(resolve => { this.resolveExit = resolve; });
  constructor(private appId: string, private logPath: string, private secrets: string[] = []) {}
  observe(data: string): void {
    this.tail = (this.tail + redactDiagnostic(data, this.secrets)).slice(-65536);
    mkdirSync(dirname(this.logPath), { recursive: true });
    writeFileSync(this.logPath, this.tail);
  }
  exit(code: number | null): void {
    this.controller.abort();
    this.resolveExit(new Error(`${this.appId} exited during startup (code ${code}). ${this.tail.slice(-6000)}\nLogs: ${this.logPath}`));
  }
  race<T>(healthy: Promise<T>): Promise<T> {
    return Promise.race([healthy, this.exited.then(error => { throw error; })]);
  }
}
