import { z } from "zod";
import { normalizeShop, redirectUri } from "../config.js";
import { openInBrowser } from "../auth.js";
import { json, safe, text, ToolContext } from "./util.js";

export function registerSessionTools({ server, config, store, login, shopify }: ToolContext): void {
  server.registerTool(
    "shopify_login",
    {
      title: "Iniciar sesión en Shopify",
      description:
        "Conecta una tienda de Shopify. Abre el navegador para que el usuario inicie sesión con su cuenta de Shopify y autorice la app; " +
        "el token se guarda en local. Úsalo la primera vez o para añadir otra tienda. Pide al usuario el dominio de la tienda si no lo sabes.",
      inputSchema: {
        shop: z
          .string()
          .describe("Dominio de la tienda: 'mi-tienda', 'mi-tienda.myshopify.com' o la URL admin.shopify.com/store/mi-tienda"),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(110)
          .default(45)
          .describe("Segundos a esperar a que el usuario termine antes de devolver el control"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    safe(async ({ shop, wait_seconds }) => {
      const domain = normalizeShop(shop);
      const url = await login.start(domain);
      const opened = openInBrowser(url);
      const state = await login.waitFor(wait_seconds * 1000);
      if (state.status === "success") {
        return text(`✅ Tienda ${state.shop} conectada con permisos: ${state.scope}. Ya puedes gestionarla.`);
      }
      if (state.status === "error") return { isError: true, content: [{ type: "text", text: `Error: ${state.message}` }] };
      return text(
        [
          opened
            ? "He abierto el navegador para iniciar sesión en Shopify."
            : "No he podido abrir el navegador automáticamente.",
          `Si no se ha abierto, abre esta URL: ${url}`,
          "",
          "Inicia sesión con tu cuenta de Shopify, pulsa «Instalar» y vuelve aquí.",
          "Después usa shopify_auth_status para confirmar (el enlace es válido durante 10 minutos).",
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "shopify_auth_status",
    {
      title: "Estado de la conexión",
      description: "Muestra si hay un inicio de sesión en curso y qué tienda está activa.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () => {
      const { activeShop, shops } = await store.list();
      const current = login.current;
      return json({
        login: current.status === "pending" ? { status: "pending", shop: current.shop, url: current.authorizeUrl } : current,
        activeShop: activeShop ?? null,
        connectedShops: shops.map((s) => s.shop),
        redirectUri: redirectUri(config),
        appConfigured: Boolean(config.clientId && config.clientSecret),
      });
    }),
  );

  server.registerTool(
    "shopify_list_stores",
    {
      title: "Tiendas conectadas",
      description: "Lista las tiendas conectadas en este equipo y cuál está activa.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () => {
      const { activeShop, shops } = await store.list();
      return json(
        shops.map((s) => ({ shop: s.shop, active: s.shop === activeShop, scope: s.scope, connectedAt: s.connectedAt })),
      );
    }),
  );

  server.registerTool(
    "shopify_switch_store",
    {
      title: "Cambiar de tienda",
      description: "Cambia la tienda activa entre las ya conectadas.",
      inputSchema: { shop: z.string() },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    safe(async ({ shop }) => {
      const domain = normalizeShop(shop);
      if (!(await store.setActive(domain))) {
        return { isError: true, content: [{ type: "text", text: `${domain} no está conectada. Usa shopify_login.` }] };
      }
      return text(`Tienda activa: ${domain}`);
    }),
  );

  server.registerTool(
    "shopify_logout",
    {
      title: "Desconectar tienda",
      description: "Borra de este equipo el token de una tienda. (Para revocar del todo, desinstala la app desde el admin de Shopify.)",
      inputSchema: { shop: z.string().optional().describe("Por defecto, la tienda activa") },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safe(async ({ shop }) => {
      const domain = shop ? normalizeShop(shop) : (await store.list()).activeShop;
      if (!domain || !(await store.remove(domain))) return text("No había ninguna sesión que cerrar.");
      return text(`Sesión de ${domain} eliminada de este equipo.`);
    }),
  );

  server.registerTool(
    "shopify_shop_info",
    {
      title: "Información de la tienda",
      description: "Datos generales de la tienda activa: nombre, dominio, moneda, plan, zona horaria y número de productos.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async () => {
      const data = await shopify.graphql(`{
        shop {
          name email myshopifyDomain primaryDomain { url }
          currencyCode ianaTimezone weightUnit
          plan { publicDisplayName partnerDevelopment shopifyPlus }
          billingAddress { country countryCodeV2 }
        }
        productsCount { count }
      }`);
      return json(data);
    }),
  );
}
