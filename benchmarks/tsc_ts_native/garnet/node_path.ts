// node:path for tsc-ts (POSIX).
export function dirname(path: string): string {
  if (path.length === 0) return '.';
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end--;
  const slash = path.lastIndexOf('/', end - 1);
  if (slash < 0) return '.';
  if (slash === 0) return '/';
  let start = slash;
  while (start > 1 && path[start - 1] === '/') start--;
  return path.slice(0, start);
}
