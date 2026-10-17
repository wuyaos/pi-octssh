import os from "node:os";
import path from "node:path";

export function getDefaultSshConfigPath() {
  // OpenSSH uses ~/.ssh/config across macOS/Linux and also on Windows (OpenSSH for Windows).
  return path.join(os.homedir(), ".ssh", "config");
}

export function getSshConfigPath() {
  const override = process.env.OCTSSH_SSH_CONFIG;
  if (override && override.trim()) return override;
  return getDefaultSshConfigPath();
}
