export function quoteForSh(value: string) {
  // Wrap value in single quotes and escape embedded single quotes.
  // 'abc' -> 'abc'
  // a'b -> 'a'\''b'
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function wrapSh(command: string) {
  return `sh -lc ${quoteForSh(command)}`;
}

export function wrapSudoSh(command: string) {
  return `sudo -n -- sh -lc ${quoteForSh(command)}`;
}

export function isSudoPasswordError(stderr: string) {
  const s = stderr.toLowerCase();
  return (
    s.includes("a password is required") ||
    s.includes("password is required") ||
    s.includes("sudo: a password is required")
  );
}
