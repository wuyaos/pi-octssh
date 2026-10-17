import path from "node:path";
import { z } from "zod";
import { atomicWriteFileSync, readJsonIfExistsSync } from "./fs.ts";
import { getOctsshDir } from "./paths.ts";

export const machineInfoSchema = z
  .object({
    name: z.string().min(1),
    updatedAt: z.string().min(1),
    os: z.string().optional(),
    arch: z.string().optional(),
    cpu: z.string().optional(),
    cores: z.number().int().positive().optional(),
    mem: z.string().optional(),
    disk: z.string().optional(),
    error: z.string().optional()
  })
  .strict();

export const inventorySchema = z
  .object({
    extended: z.boolean(),
    machines: z.array(machineInfoSchema)
  })
  .strict();

export type Inventory = z.infer<typeof inventorySchema>;

export function getInventoryPath(baseDir?: string) {
  const root = baseDir ?? getOctsshDir();
  return path.join(root, "inventory.json");
}

export function loadInventory(baseDir?: string): Inventory | null {
  const p = getInventoryPath(baseDir);
  const json = readJsonIfExistsSync<unknown>(p);
  if (!json) return null;
  return inventorySchema.parse(json);
}

export function saveInventory(inv: Inventory, baseDir?: string) {
  const p = getInventoryPath(baseDir);
  const normalized = inventorySchema.parse(inv);
  atomicWriteFileSync(p, JSON.stringify(normalized, null, 2) + "\n");
}
