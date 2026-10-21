// node:child_process for tsc-ts: no child processes on this host. spawnSync
// fails (the terminal width falls back to 0); spawn throws.
export interface SpawnSyncResult { status: number | null; stdout: string; stderr: string; signal: string | null }
export function spawnSync(_command: string, _args?: readonly string[], _options?: unknown): SpawnSyncResult {
  return { status: null, stdout: '', stderr: '', signal: null };
}
export interface ChildProcess {
  on(event: 'error', listener: (error: Error) => void): ChildProcess;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): ChildProcess;
}
export function spawn(_command: string, _args?: readonly string[], _options?: unknown): ChildProcess {
  throw new Error('child processes are not available in the garnet build of tsc-ts');
}
