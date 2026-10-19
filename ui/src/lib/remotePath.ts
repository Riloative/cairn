/** Paths on devices (POSIX-style or IOS-style `flash:`) and permission display. */

/** POSIX join for remote paths (device paths like `flash:` are used as typed). */
export function joinRemote(dir: string, name: string): string {
  if (!dir || dir === ".") return name;
  if (dir.endsWith("/") || dir.endsWith(":")) return `${dir}${name}`;
  return `${dir}/${name}`;
}

export function parentRemote(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return "/";
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}
