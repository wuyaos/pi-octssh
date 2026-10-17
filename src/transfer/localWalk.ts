import fs from "node:fs";
import path from "node:path";

export type LocalEntry = {
  absPath: string;
  relPath: string;
  isFile: boolean;
  isDir: boolean;
  size: number;
};

function assertRegularFileOrDirectory(entryPath: string): fs.Stats {
  const stats = fs.lstatSync(entryPath);
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
    throw new Error(`Unsupported local path type (symlinks are not allowed): ${entryPath}`);
  }
  return stats;
}

export function walkLocal(rootPath: string): LocalEntry[] {
  const st = assertRegularFileOrDirectory(rootPath);
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
      const s = assertRegularFileOrDirectory(abs);
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
