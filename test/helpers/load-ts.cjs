const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const projectRoot = path.resolve(__dirname, "..", "..");

/**
 * Load a TypeScript source module through Node 24's built-in type stripping.
 * Tests remain plain node:test CommonJS files, while production sources keep
 * their native ESM imports and .ts extension specifiers.
 */
async function loadTs(relativePath) {
  const absolutePath = path.join(projectRoot, "src", relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`Missing source module: ${relativePath}`);
  return import(`${pathToFileURL(absolutePath).href}?test=${Date.now()}-${Math.random()}`);
}

module.exports = { loadTs };
