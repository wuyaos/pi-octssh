import fs from "node:fs";
import path from "node:path";

export function ensureDirSync(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function atomicWriteFileSync(filePath: string, contents: string) {
  const dir = path.dirname(filePath);
  ensureDirSync(dir);

  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, contents, { encoding: "utf8" });
  // Windows 上 renameSync 目标已存在会报 EPERM,先尝试删除。
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* 目标不存在,忽略 */
  }
  fs.renameSync(tmpPath, filePath);
}

export function readJsonIfExistsSync<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
    throw err;
  }
}
