#!/usr/bin/env node
/**
 * Re-fetches the Pennylane OpenAPI spec from the official docs site.
 * Run with: npm run sync:openapi
 */
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OPENAPI_URL = 'https://pennylane.readme.io/openapi/accounting.json';
const OUT = new URL('../openapi/accounting.json', import.meta.url);

async function countPaths(filePath: URL): Promise<number> {
  if (!existsSync(filePath)) return 0;
  const raw = await readFile(filePath, 'utf-8');
  const json = JSON.parse(raw) as { paths?: Record<string, unknown> };
  return Object.keys(json.paths ?? {}).length;
}

async function main(): Promise<void> {
  const before = await countPaths(OUT);

  process.stderr.write(`Fetching ${OPENAPI_URL}...\n`);
  const res = await fetch(OPENAPI_URL);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} when fetching OpenAPI`);
  }
  const text = await res.text();
  // Validate it parses.
  const json = JSON.parse(text) as { paths?: Record<string, unknown>; info?: { version?: string } };
  await writeFile(OUT, text);

  const after = Object.keys(json.paths ?? {}).length;
  const version = json.info?.version ?? 'unknown';
  process.stderr.write(
    `OpenAPI synced: ${after} paths (was ${before}, delta ${after - before >= 0 ? '+' : ''}${after - before}), spec version ${version}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`sync-openapi failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
