import fs from "node:fs";
import path from "node:path";

export type LocalEntry = {
  absPath: string;
  relPath: string;
  isFile: boolean;
  isDir: boolean;
  size: number;
};

export function walkLocal(rootPath: string): LocalEntry[] {
  const st = fs.statSync(rootPath);
  if (st.isFile()) {
    return [
      {
        absPath: rootPath,
        relPath: path.basename(rootPath),
        isFile: true,
        isDir: false,
        size: st.size,
      },
    ];
  }
  if (!st.isDirectory()) {
    throw new Error(`Unsupported local path type: ${rootPath}`);
  }

  const entries: LocalEntry[] = [];
  const base = rootPath;

  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = path.relative(base, abs).split(path.sep).join("/");
      const s = fs.statSync(abs);
      if (s.isDirectory()) {
        entries.push({ absPath: abs, relPath: rel, isFile: false, isDir: true, size: 0 });
        walk(abs);
      } else if (s.isFile()) {
        entries.push({ absPath: abs, relPath: rel, isFile: true, isDir: false, size: s.size });
      }
    }
  };

  walk(rootPath);
  return entries;
}
