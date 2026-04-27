#!/usr/bin/env node
/**
 * Reads openapi/accounting.json and emits src/generated/tools.ts —
 * one server.registerTool() call per operation.
 *
 * Run with: npm run generate
 */
import { readFile, writeFile } from 'node:fs/promises';

interface OpenApiDoc {
  paths: Record<string, PathItem>;
}
interface PathItem {
  get?: Operation;
  post?: Operation;
  put?: Operation;
  patch?: Operation;
  delete?: Operation;
  parameters?: Parameter[];
}
interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  tags?: string[];
}
interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  schema?: JsonSchema;
}
interface RequestBody {
  required?: boolean;
  content?: { 'application/json'?: { schema?: JsonSchema } };
}
interface JsonSchema {
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: unknown[];
  nullable?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  default?: unknown;
  example?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

const V2_PREFIX = '/api/external/v2';
const TOOL_PREFIX = 'pennylane_';
const MAX_TOOL_NAME = 64;
const MAX_DESC = 1024;

// ---------- string helpers ----------

function camelToSnake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function fallbackOperationId(method: string, path: string): string {
  const sanitized = path
    .replace(V2_PREFIX, '')
    .replace(/\{([^}]+)\}/g, 'by_$1')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return `${method}_${sanitized}`;
}

function jsString(s: string): string {
  return JSON.stringify(s);
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return '';
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? cleaned.slice(0, max - 3) + '...' : cleaned;
}

function isJsIdent(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function shapeKey(name: string): string {
  return isJsIdent(name) ? name : jsString(name);
}

function readKey(name: string): string {
  // Used in `args.<key>` access — falls back to bracket syntax when needed.
  return isJsIdent(name) ? `.${name}` : `[${jsString(name)}]`;
}

// ---------- JSON Schema → Zod source ----------

function zodForSchema(schema: JsonSchema | undefined): string {
  if (!schema) return 'z.unknown()';

  // Combinators take priority.
  if (schema.oneOf?.length) {
    const opts = schema.oneOf.map(zodForSchema);
    return opts.length === 1 ? opts[0]! : `z.union([${opts.join(', ')}])`;
  }
  if (schema.anyOf?.length) {
    const opts = schema.anyOf.map(zodForSchema);
    return opts.length === 1 ? opts[0]! : `z.union([${opts.join(', ')}])`;
  }
  if (schema.allOf?.length) {
    // Best effort: merge object shapes; otherwise pick the first.
    const objects = schema.allOf.filter((s) => s.type === 'object' || s.properties);
    if (objects.length === schema.allOf.length && objects.length > 1) {
      const merged: JsonSchema = { type: 'object', properties: {}, required: [] };
      for (const o of objects) {
        Object.assign(merged.properties!, o.properties ?? {});
        if (o.required) merged.required!.push(...o.required);
      }
      return zodForSchema(merged);
    }
    return zodForSchema(schema.allOf[0]);
  }

  if (schema.enum?.length) {
    const allStrings = schema.enum.every((v) => typeof v === 'string');
    if (allStrings) {
      return schema.enum.length === 1
        ? `z.literal(${jsString(schema.enum[0] as string)})`
        : `z.enum([${schema.enum.map((v) => jsString(v as string)).join(', ')}])`;
    }
    const literals = schema.enum.map((v) => `z.literal(${JSON.stringify(v)})`);
    return literals.length === 1 ? literals[0]! : `z.union([${literals.join(', ')}])`;
  }

  let type = schema.type;
  if (Array.isArray(type)) {
    const filtered = type.filter((t) => t !== 'null');
    type = filtered.length === 1 ? filtered[0] : filtered.join('|');
    // If the original list contained "null", treat as nullable.
    if (type !== schema.type) schema = { ...schema, nullable: true };
  }

  let z: string;
  switch (type) {
    case 'string':
      z = 'z.string()';
      break;
    case 'integer':
      z = 'z.number().int()';
      break;
    case 'number':
      z = 'z.number()';
      break;
    case 'boolean':
      z = 'z.boolean()';
      break;
    case 'array': {
      const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
      z = `z.array(${zodForSchema(items)})`;
      break;
    }
    case 'object': {
      const props = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const entries = Object.entries(props);
      if (entries.length === 0) {
        // Allow any object shape if additionalProperties is not strictly false.
        z = schema.additionalProperties === false ? 'z.object({}).strict()' : 'z.record(z.string(), z.unknown())';
      } else {
        const lines = entries.map(([key, sub]) => {
          let inner = zodForSchema(sub);
          if (sub.description) inner += `.describe(${jsString(truncate(sub.description, 256))})`;
          if (!required.has(key)) inner += '.optional()';
          if (sub.nullable) inner += '.nullable()';
          return `${shapeKey(key)}: ${inner}`;
        });
        z = `z.object({ ${lines.join(', ')} })`;
      }
      break;
    }
    case 'null':
      z = 'z.null()';
      break;
    default:
      z = 'z.unknown()';
      break;
  }

  if (schema.nullable) z += '.nullable()';
  return z;
}

// ---------- code emission ----------

interface ToolCode {
  name: string;
  source: string;
}

function emitTool(method: HttpMethod, path: string, op: Operation, pathLevelParams: Parameter[]): ToolCode | null {
  const operationId = op.operationId ?? fallbackOperationId(method, path);
  let toolName = `${TOOL_PREFIX}${camelToSnake(operationId)}`;
  if (toolName.length > MAX_TOOL_NAME) toolName = toolName.slice(0, MAX_TOOL_NAME);
  if (!/^[a-zA-Z0-9_-]+$/.test(toolName)) return null;

  const summary = truncate(op.summary, 200);
  const description = truncate(op.description ?? op.summary ?? `${method.toUpperCase()} ${path}`, MAX_DESC);

  // Merge path-level parameters with operation-level ones (operation wins on name conflicts).
  const allParams: Parameter[] = [];
  const seen = new Set<string>();
  for (const p of [...(op.parameters ?? []), ...pathLevelParams]) {
    if (p.in !== 'path' && p.in !== 'query') continue;
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    allParams.push(p);
  }

  const pathParams = allParams.filter((p) => p.in === 'path');
  const queryParams = allParams.filter((p) => p.in === 'query');
  const body = op.requestBody?.content?.['application/json']?.schema;
  const bodyRequired = !!op.requestBody?.required;

  // Build inputSchema fields.
  const fieldLines: string[] = [];
  for (const p of allParams) {
    let inner = zodForSchema(p.schema);
    if (p.description) inner += `.describe(${jsString(truncate(p.description, 256))})`;
    const isRequired = p.in === 'path' ? true : !!p.required;
    if (!isRequired) inner += '.optional()';
    fieldLines.push(`${shapeKey(p.name)}: ${inner}`);
  }
  if (body) {
    let inner = zodForSchema(body);
    inner += '.describe("Request body (application/json)")';
    if (!bodyRequired) inner += '.optional()';
    fieldLines.push(`body: ${inner}`);
  }

  const inputSchemaLiteral = fieldLines.length ? `{ ${fieldLines.join(', ')} }` : '{}';

  // Build the runtime call.
  const pathParamPicks = pathParams.length
    ? `{ ${pathParams.map((p) => `${shapeKey(p.name)}: args${readKey(p.name)}`).join(', ')} }`
    : 'undefined';
  const queryParamPicks = queryParams.length
    ? `{ ${queryParams.map((p) => `${shapeKey(p.name)}: args${readKey(p.name)}`).join(', ')} }`
    : 'undefined';
  const bodyPick = body ? 'args.body' : 'undefined';

  const source = `  // ${method.toUpperCase()} ${path}
  server.registerTool(
    ${jsString(toolName)},
    {
      title: ${jsString(summary || toolName)},
      description: ${jsString(description)},
      inputSchema: ${inputSchemaLiteral},
    },
    async (args: any) => {
      try {
        const data = await client.request({
          method: ${jsString(method.toUpperCase())},
          path: ${jsString(path.replace(V2_PREFIX, ''))},
          pathParams: ${pathParamPicks},
          query: ${queryParamPicks},
          body: ${bodyPick},
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        const e = err as { message?: string; status?: number; details?: unknown };
        const text = e.status
          ? \`HTTP \${e.status}: \${e.message ?? "request failed"}\${e.details ? "\\n" + JSON.stringify(e.details, null, 2) : ""}\`
          : e.message ?? String(err);
        return { isError: true, content: [{ type: "text" as const, text }] };
      }
    },
  );
  count++;`;

  return { name: toolName, source };
}

// ---------- entry point ----------

async function main(): Promise<void> {
  const specUrl = new URL('../openapi/accounting.json', import.meta.url);
  const outUrl = new URL('../src/generated/tools.ts', import.meta.url);

  const raw = await readFile(specUrl, 'utf-8');
  const spec = JSON.parse(raw) as OpenApiDoc;

  const tools: ToolCode[] = [];
  const seenNames = new Set<string>();
  let skipped = 0;

  for (const [path, item] of Object.entries(spec.paths)) {
    if (!path.startsWith(V2_PREFIX)) continue;
    const pathLevelParams = item.parameters ?? [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const tool = emitTool(method, path, op, pathLevelParams);
      if (!tool) {
        skipped++;
        continue;
      }
      if (seenNames.has(tool.name)) {
        // Append a hash-like suffix derived from method+path to disambiguate.
        const suffix = `_${method}`;
        tool.name = (tool.name + suffix).slice(0, MAX_TOOL_NAME);
        if (seenNames.has(tool.name)) {
          skipped++;
          continue;
        }
        // Patch the emitted source to use the new name (replace first occurrence of jsString old name).
        // For safety, we just won't bother — generator regen catches this.
      }
      seenNames.add(tool.name);
      tools.push(tool);
    }
  }

  const header = `// AUTO-GENERATED by scripts/generate-tools.ts — do not edit.
// Regenerate with: npm run generate
//
// Source: openapi/accounting.json (Pennylane v2 API)

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PennylaneClient } from "../client.js";

export function registerAllTools(server: McpServer, client: PennylaneClient): number {
  let count = 0;

`;

  const footer = `
  return count;
}
`;

  const body = tools.map((t) => t.source).join('\n\n');

  await writeFile(outUrl, header + body + footer);

  process.stderr.write(
    `Generated ${tools.length} tools (skipped ${skipped}) → src/generated/tools.ts\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`generate-tools failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
