import { z } from "zod";
import { json, READ_ONLY, safe, ToolContext } from "./util.js";

interface AuditProduct {
  id: string;
  title: string;
  handle: string;
  status: string;
  description: string;
  productType: string;
  vendor: string;
  tags: string[];
  totalInventory: number | null;
  tracksInventory: boolean;
  seo: { title: string | null; description: string | null };
  mediaCount: { count: number } | null;
  media: { nodes: Array<{ alt: string | null }> };
  variants: { nodes: Array<{ price: string; compareAtPrice: string | null; sku: string | null }> };
}

type Check = { key: string; label: string; test: (p: AuditProduct) => boolean };

const CHECKS: Check[] = [
  { key: "no_images", label: "Sin imágenes", test: (p) => (p.mediaCount?.count ?? p.media.nodes.length) === 0 },
  { key: "images_without_alt", label: "Imágenes sin texto alternativo (alt)", test: (p) => p.media.nodes.some((m) => !m.alt?.trim()) },
  { key: "short_description", label: "Descripción vacía o muy corta (<100 caracteres)", test: (p) => p.description.trim().length < 100 },
  { key: "no_seo_title", label: "Sin título SEO personalizado", test: (p) => !p.seo.title?.trim() },
  { key: "no_seo_description", label: "Sin meta descripción SEO", test: (p) => !p.seo.description?.trim() },
  { key: "seo_title_too_long", label: "Título SEO > 70 caracteres", test: (p) => (p.seo.title ?? p.title).length > 70 },
  { key: "no_product_type", label: "Sin tipo de producto", test: (p) => !p.productType?.trim() },
  { key: "no_tags", label: "Sin etiquetas", test: (p) => p.tags.length === 0 },
  { key: "missing_sku", label: "Variantes sin SKU", test: (p) => p.variants.nodes.some((v) => !v.sku?.trim()) },
  { key: "zero_price", label: "Variantes con precio 0", test: (p) => p.variants.nodes.some((v) => Number(v.price) === 0) },
  {
    key: "bad_compare_at",
    label: "Precio comparativo menor o igual que el precio",
    test: (p) => p.variants.nodes.some((v) => v.compareAtPrice !== null && Number(v.compareAtPrice) <= Number(v.price)),
  },
  {
    key: "active_out_of_stock",
    label: "Activo pero sin stock",
    test: (p) => p.status === "ACTIVE" && p.tracksInventory && (p.totalInventory ?? 0) <= 0,
  },
  { key: "draft", label: "En borrador (no visible en la tienda)", test: (p) => p.status === "DRAFT" },
];

export function registerAuditTools({ server, shopify }: ToolContext): void {
  server.registerTool(
    "shopify_store_audit",
    {
      title: "Auditoría de catálogo",
      description:
        "Revisa el catálogo y detecta problemas que restan ventas o SEO: productos sin imágenes, sin alt, descripciones pobres, SEO vacío, sin stock, sin SKU, precios incoherentes... " +
        "Úsalo como punto de partida para proponer mejoras al usuario.",
      inputSchema: {
        max_products: z.number().int().min(1).max(2500).default(500),
        query: z.string().optional().describe("Filtro opcional, p. ej. 'status:active'"),
        examples_per_issue: z.number().int().min(0).max(50).default(10),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ max_products, query, examples_per_issue }) => {
      const products: AuditProduct[] = [];
      let after: string | null = null;
      while (products.length < max_products) {
        const first = Math.min(100, max_products - products.length);
        const data: any = await shopify.graphql(
          `query($first:Int!,$after:String,$query:String){
            products(first:$first, after:$after, query:$query){
              nodes {
                id title handle status description productType vendor tags totalInventory tracksInventory
                seo { title description }
                mediaCount { count }
                media(first: 10) { nodes { alt } }
                variants(first: 50) { nodes { price compareAtPrice sku } }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { first, after, query },
        );
        products.push(...data.products.nodes);
        if (!data.products.pageInfo.hasNextPage) break;
        after = data.products.pageInfo.endCursor;
      }

      const issues = CHECKS.map((c) => {
        const hits = products.filter(c.test);
        return {
          issue: c.key,
          label: c.label,
          count: hits.length,
          examples: hits.slice(0, examples_per_issue).map((p) => ({ id: p.id, title: p.title, handle: p.handle })),
        };
      })
        .filter((i) => i.count > 0)
        .sort((a, b) => b.count - a.count);

      const healthy = products.filter((p) => !CHECKS.some((c) => c.key !== "draft" && c.test(p))).length;
      return json({
        analyzedProducts: products.length,
        truncated: products.length >= max_products,
        productsWithoutIssues: healthy,
        issues,
      });
    }),
  );

  server.registerTool(
    "shopify_graphql",
    {
      title: "Consulta GraphQL avanzada",
      description:
        "Ejecuta cualquier consulta o mutación de la Admin GraphQL API de Shopify sobre la tienda activa, para lo que no cubran las demás herramientas " +
        "(descuentos, menús, traducciones, blogs, etc.). Para mutaciones, explica antes al usuario qué vas a cambiar.",
      inputSchema: {
        query: z.string().describe("Documento GraphQL"),
        variables: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe(async ({ query, variables }) => json(await shopify.graphql(query, variables))),
  );
}
