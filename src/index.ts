#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { CredentialStore } from "./store.js";
import { LoginManager } from "./auth.js";
import { ShopifyClient } from "./shopify.js";
import { registerSessionTools } from "./tools/session.js";
import { registerProductTools } from "./tools/products.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerContentTools } from "./tools/content.js";
import { registerAuditTools } from "./tools/audit.js";

const INSTRUCTIONS = `Servidor MCP para administrar tiendas Shopify del usuario.
- Si una herramienta dice que no hay tienda conectada, pide al usuario el dominio de su tienda y usa shopify_login: se abrirá su navegador para iniciar sesión con su cuenta de Shopify.
- Antes de cambios masivos o destructivos (borrar, cambiar muchos precios, despublicar) resume lo que vas a hacer y pide confirmación.
- Para proponer mejoras empieza por shopify_store_audit y shopify_shop_info.
- Lo que no cubran las herramientas específicas se puede hacer con shopify_graphql.`;

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new CredentialStore(config.configDir);
  const login = new LoginManager(config, store);
  const shopify = new ShopifyClient(config, store);

  const server = new McpServer({ name: "mcp-for-shopify", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const ctx = { server, config, store, login, shopify };
  registerSessionTools(ctx);
  registerProductTools(ctx);
  registerCatalogTools(ctx);
  registerContentTools(ctx);
  registerAuditTools(ctx);

  const shutdown = () => {
    login.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  // stdout está reservado para el protocolo MCP: los logs van a stderr.
  console.error(`mcp-for-shopify listo. Credenciales en ${store.path}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
