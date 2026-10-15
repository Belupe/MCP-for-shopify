import os from "node:os";
import path from "node:path";

export const DEFAULT_SCOPES = [
  "read_products",
  "write_products",
  "read_inventory",
  "write_inventory",
  "read_locations",
  "read_orders",
  "read_customers",
  "write_customers",
  "read_content",
  "write_content",
].join(",");

export interface AppConfig {
  clientId?: string;
  clientSecret?: string;
  redirectPort: number;
  scopes: string;
  apiVersion: string;
  configDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.SHOPIFY_REDIRECT_PORT ?? 3457);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SHOPIFY_REDIRECT_PORT no es un puerto válido: ${env.SHOPIFY_REDIRECT_PORT}`);
  }
  return {
    clientId: env.SHOPIFY_CLIENT_ID?.trim() || undefined,
    clientSecret: env.SHOPIFY_CLIENT_SECRET?.trim() || undefined,
    redirectPort: port,
    scopes: (env.SHOPIFY_SCOPES ?? DEFAULT_SCOPES).replace(/\s+/g, ""),
    apiVersion: env.SHOPIFY_API_VERSION ?? "2026-07",
    configDir:
      env.MCP_SHOPIFY_CONFIG_DIR ??
      path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "mcp-for-shopify"),
  };
}

export function redirectUri(config: AppConfig): string {
  return `http://localhost:${config.redirectPort}/auth/callback`;
}

/**
 * Normaliza lo que escriba el usuario ("mi-tienda", "mi-tienda.myshopify.com",
 * "https://mi-tienda.myshopify.com/admin") a "mi-tienda.myshopify.com".
 * Solo se aceptan dominios *.myshopify.com para no enviar nunca el secreto a otro host.
 */
export function normalizeShop(input: string): string {
  let shop = input.trim().toLowerCase();
  shop = shop.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  // admin.shopify.com/store/<handle>
  const adminMatch = input.trim().toLowerCase().match(/admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/);
  if (adminMatch) shop = adminMatch[1];
  if (!shop.includes(".")) shop = `${shop}.myshopify.com`;
  if (!isValidShopDomain(shop)) {
    throw new Error(
      `"${input}" no es un dominio de tienda válido. Usa el dominio *.myshopify.com (por ejemplo: mi-tienda.myshopify.com).`,
    );
  }
  return shop;
}

export function isValidShopDomain(shop: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}
