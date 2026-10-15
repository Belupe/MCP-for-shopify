import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import type { LoginManager } from "../auth.js";
import type { ShopifyClient } from "../shopify.js";
import type { CredentialStore } from "../store.js";

export interface ToolContext {
  server: McpServer;
  config: AppConfig;
  store: CredentialStore;
  login: LoginManager;
  shopify: ShopifyClient;
}

export function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function text(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

/** Envuelve un handler para devolver los errores como resultado de herramienta (isError) en vez de romper. */
export function safe<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
    }
  };
}

/** Aplana `edges { node }` a una lista. */
export function nodes<T>(conn: { edges?: Array<{ node: T }>; nodes?: T[] } | null | undefined): T[] {
  if (!conn) return [];
  return conn.nodes ?? conn.edges?.map((e) => e.node) ?? [];
}

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;
