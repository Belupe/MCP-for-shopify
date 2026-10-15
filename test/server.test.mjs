import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("el servidor MCP arranca y expone las herramientas", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-shopify-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, MCP_SHOPIFY_CONFIG_DIR: dir, SHOPIFY_CLIENT_ID: "", SHOPIFY_CLIENT_SECRET: "" },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["shopify_login", "shopify_list_products", "shopify_update_product", "shopify_store_audit", "shopify_graphql"]) {
    assert.ok(names.includes(n), n);
  }
  const notConnected = await client.callTool({ name: "shopify_list_products", arguments: {} });
  assert.equal(notConnected.isError, true);
  assert.match(notConnected.content[0].text, /shopify_login/);

  const noApp = await client.callTool({ name: "shopify_login", arguments: { shop: "demo" } });
  assert.equal(noApp.isError, true);
  assert.match(noApp.content[0].text, /SHOPIFY_CLIENT_ID/);
  console.log(`${names.length} herramientas`);
  await client.close();
});
