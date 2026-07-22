import os from "node:os";
import path from "node:path";

export function getDefaultOctsshDir() {
  return path.join(os.homedir(), ".octssh");
}

export function getOctsshDir() {
  // Allow callers (and tests) to override storage root.
  const override = process.env.OCTSSH_HOME;
  if (override && override.trim()) return override;
  return getDefaultOctsshDir();
}
