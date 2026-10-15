import crypto from "node:crypto";
import { z } from "zod";
import { assertNoUserErrors, toGid } from "../shopify.js";
import { DESTRUCTIVE, json, nodes, READ_ONLY, safe, text, ToolContext, WRITE } from "./util.js";

const PRODUCT_SUMMARY = `
  id title handle status vendor productType tags totalInventory
  updatedAt onlineStoreUrl
  priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
  featuredMedia { preview { image { url altText } } }
`;

const PRODUCT_DETAIL = `
  id title handle status vendor productType tags descriptionHtml
  createdAt updatedAt publishedAt onlineStoreUrl totalInventory
  seo { title description }
  options { id name values }
  media(first: 20) { nodes { id alt mediaContentType preview { image { url } } } }
  collections(first: 20) { nodes { id title handle } }
  variants(first: 100) {
    nodes {
      id title sku barcode price compareAtPrice inventoryQuantity taxable
      selectedOptions { name value }
      inventoryItem { id tracked }
    }
  }
`;

const statusEnum = z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]);
const seoSchema = z
  .object({ title: z.string().optional(), description: z.string().optional() })
  .describe("SEO: título y meta descripción para buscadores");

export function registerProductTools({ server, shopify }: ToolContext): void {
  server.registerTool(
    "shopify_list_products",
    {
      title: "Listar productos",
      description:
        "Lista productos con búsqueda opcional (sintaxis de búsqueda de Shopify, p. ej. 'title:*camiseta*', 'status:draft', 'vendor:Nike', 'inventory_total:0', 'tag:oferta').",
      inputSchema: {
        query: z.string().optional(),
        first: z.number().int().min(1).max(100).default(25),
        after: z.string().optional().describe("Cursor de paginación (endCursor de la respuesta anterior)"),
        sort_key: z.enum(["TITLE", "UPDATED_AT", "CREATED_AT", "INVENTORY_TOTAL", "PRODUCT_TYPE", "VENDOR"]).default("UPDATED_AT"),
        reverse: z.boolean().default(true),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ query, first, after, sort_key, reverse }) => {
      const data = await shopify.graphql(
        `query($first:Int!,$after:String,$query:String,$sortKey:ProductSortKeys,$reverse:Boolean){
          products(first:$first, after:$after, query:$query, sortKey:$sortKey, reverse:$reverse){
            nodes { ${PRODUCT_SUMMARY} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first, after, query, sortKey: sort_key, reverse },
      );
      return json(data.products);
    }),
  );

  server.registerTool(
    "shopify_get_product",
    {
      title: "Ver producto",
      description: "Detalle completo de un producto (descripción, SEO, variantes, imágenes, colecciones). Por ID o por handle.",
      inputSchema: {
        id: z.string().optional().describe("ID numérico o gid://shopify/Product/..."),
        handle: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ id, handle }) => {
      if (!id && !handle) throw new Error("Indica id o handle.");
      const data = id
        ? await shopify.graphql(`query($id:ID!){ product(id:$id){ ${PRODUCT_DETAIL} } }`, { id: toGid("Product", id) })
        : await shopify.graphql(
            `query($handle:String!){ productByIdentifier(identifier:{handle:$handle}){ ${PRODUCT_DETAIL} } }`,
            { handle },
          );
      const product = data.product ?? data.productByIdentifier;
      if (!product) throw new Error("Producto no encontrado.");
      return json(product);
    }),
  );

  server.registerTool(
    "shopify_create_product",
    {
      title: "Crear producto",
      description:
        "Crea un producto (por defecto en borrador). Opcionalmente fija precio/SKU de la variante por defecto y añade imágenes desde URLs públicas.",
      inputSchema: {
        title: z.string(),
        description_html: z.string().optional(),
        vendor: z.string().optional(),
        product_type: z.string().optional(),
        tags: z.array(z.string()).optional(),
        status: statusEnum.default("DRAFT"),
        handle: z.string().optional(),
        seo: seoSchema.optional(),
        price: z.string().optional().describe("Precio, p. ej. '19.99'"),
        compare_at_price: z.string().optional(),
        sku: z.string().optional(),
        images: z.array(z.object({ url: z.string().url(), alt: z.string().optional() })).optional(),
      },
      annotations: WRITE,
    },
    safe(async (a) => {
      const data = await shopify.graphql(
        `mutation($product:ProductCreateInput!,$media:[CreateMediaInput!]){
          productCreate(product:$product, media:$media){
            product { id title handle status variants(first:1){ nodes { id } } }
            userErrors { field message }
          }
        }`,
        {
          product: {
            title: a.title,
            descriptionHtml: a.description_html,
            vendor: a.vendor,
            productType: a.product_type,
            tags: a.tags,
            status: a.status,
            handle: a.handle,
            seo: a.seo,
          },
          media: a.images?.map((i) => ({ originalSource: i.url, alt: i.alt, mediaContentType: "IMAGE" })),
        },
      );
      assertNoUserErrors(data.productCreate);
      const product = data.productCreate.product;

      if (a.price || a.compare_at_price || a.sku) {
        const variantId = product.variants.nodes[0]?.id;
        const upd = await shopify.graphql(
          `mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!){
            productVariantsBulkUpdate(productId:$productId, variants:$variants){
              productVariants { id price compareAtPrice sku }
              userErrors { field message }
            }
          }`,
          {
            productId: product.id,
            variants: [
              {
                id: variantId,
                price: a.price,
                compareAtPrice: a.compare_at_price,
                inventoryItem: a.sku ? { sku: a.sku } : undefined,
              },
            ],
          },
        );
        assertNoUserErrors(upd.productVariantsBulkUpdate);
        product.variants = upd.productVariantsBulkUpdate.productVariants;
      }
      return json(product);
    }),
  );

  server.registerTool(
    "shopify_update_product",
    {
      title: "Editar producto",
      description:
        "Modifica campos de un producto: título, descripción HTML, SEO, etiquetas, tipo, proveedor, estado (ACTIVE/DRAFT/ARCHIVED) o handle. Solo se cambian los campos indicados.",
      inputSchema: {
        id: z.string().describe("ID numérico o GID del producto"),
        title: z.string().optional(),
        description_html: z.string().optional(),
        vendor: z.string().optional(),
        product_type: z.string().optional(),
        tags: z.array(z.string()).optional().describe("Sustituye TODAS las etiquetas"),
        status: statusEnum.optional(),
        handle: z.string().optional(),
        seo: seoSchema.optional(),
      },
      annotations: WRITE,
    },
    safe(async (a) => {
      const data = await shopify.graphql(
        `mutation($product:ProductUpdateInput!){
          productUpdate(product:$product){
            product { id title handle status vendor productType tags seo { title description } updatedAt }
            userErrors { field message }
          }
        }`,
        {
          product: {
            id: toGid("Product", a.id),
            title: a.title,
            descriptionHtml: a.description_html,
            vendor: a.vendor,
            productType: a.product_type,
            tags: a.tags,
            status: a.status,
            handle: a.handle,
            seo: a.seo,
          },
        },
      );
      assertNoUserErrors(data.productUpdate);
      return json(data.productUpdate.product);
    }),
  );

  server.registerTool(
    "shopify_delete_product",
    {
      title: "Eliminar producto",
      description:
        "Elimina un producto de forma PERMANENTE. Antes, confirma con el usuario. Si solo quiere ocultarlo, usa shopify_update_product con status ARCHIVED o DRAFT.",
      inputSchema: {
        id: z.string(),
        confirm: z.literal(true).describe("Debe ser true; confirma que el usuario aprobó el borrado"),
      },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ id }) => {
      const data = await shopify.graphql(
        `mutation($input:ProductDeleteInput!){ productDelete(input:$input){ deletedProductId userErrors { field message } } }`,
        { input: { id: toGid("Product", id) } },
      );
      assertNoUserErrors(data.productDelete);
      return text(`Producto eliminado: ${data.productDelete.deletedProductId}`);
    }),
  );

  server.registerTool(
    "shopify_update_variants",
    {
      title: "Editar variantes (precios, SKU...)",
      description: "Actualiza en bloque precio, precio comparativo, SKU, código de barras o impuestos de variantes de un producto.",
      inputSchema: {
        product_id: z.string(),
        variants: z
          .array(
            z.object({
              id: z.string().describe("ID numérico o GID de la variante"),
              price: z.string().optional(),
              compare_at_price: z.string().nullable().optional().describe("null para quitar el precio tachado"),
              sku: z.string().optional(),
              barcode: z.string().optional(),
              taxable: z.boolean().optional(),
            }),
          )
          .min(1),
      },
      annotations: WRITE,
    },
    safe(async ({ product_id, variants }) => {
      const data = await shopify.graphql(
        `mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!){
          productVariantsBulkUpdate(productId:$productId, variants:$variants){
            productVariants { id title price compareAtPrice sku barcode taxable }
            userErrors { field message }
          }
        }`,
        {
          productId: toGid("Product", product_id),
          variants: variants.map((v) => ({
            id: toGid("ProductVariant", v.id),
            price: v.price,
            compareAtPrice: v.compare_at_price,
            barcode: v.barcode,
            taxable: v.taxable,
            inventoryItem: v.sku !== undefined ? { sku: v.sku } : undefined,
          })),
        },
      );
      assertNoUserErrors(data.productVariantsBulkUpdate);
      return json(data.productVariantsBulkUpdate.productVariants);
    }),
  );

  server.registerTool(
    "shopify_add_product_images",
    {
      title: "Añadir imágenes a un producto",
      description: "Añade imágenes a un producto desde URLs públicas, con texto alternativo (alt) para accesibilidad y SEO.",
      inputSchema: {
        product_id: z.string(),
        images: z.array(z.object({ url: z.string().url(), alt: z.string().optional() })).min(1),
      },
      annotations: WRITE,
    },
    safe(async ({ product_id, images }) => {
      const data = await shopify.graphql(
        `mutation($product:ProductUpdateInput!,$media:[CreateMediaInput!]){
          productUpdate(product:$product, media:$media){
            product { id media(first:50){ nodes { id alt status } } }
            userErrors { field message }
          }
        }`,
        {
          product: { id: toGid("Product", product_id) },
          media: images.map((i) => ({ originalSource: i.url, alt: i.alt, mediaContentType: "IMAGE" })),
        },
      );
      assertNoUserErrors(data.productUpdate);
      return json(data.productUpdate.product);
    }),
  );

  server.registerTool(
    "shopify_list_locations",
    {
      title: "Listar ubicaciones",
      description: "Lista las ubicaciones (almacenes/tiendas físicas) donde se guarda inventario.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    safe(async () => {
      const data = await shopify.graphql(`{
        locations(first: 50) { nodes { id name isActive fulfillsOnlineOrders address { city country } } }
      }`);
      return json(nodes(data.locations));
    }),
  );

  server.registerTool(
    "shopify_set_inventory",
    {
      title: "Fijar stock",
      description:
        "Fija la cantidad disponible de una variante en una ubicación. Si no indicas ubicación, se usa la primera ubicación activa.",
      inputSchema: {
        variant_id: z.string(),
        quantity: z.number().int(),
        location_id: z.string().optional(),
      },
      annotations: WRITE,
    },
    safe(async ({ variant_id, quantity, location_id }) => {
      let locationId = location_id ? toGid("Location", location_id) : undefined;
      if (!locationId) {
        const locs = await shopify.graphql(`{ locations(first: 10, query: "active:true") { nodes { id name } } }`);
        locationId = nodes<{ id: string }>(locs.locations)[0]?.id;
        if (!locationId) throw new Error("No hay ubicaciones activas.");
      }
      const v = await shopify.graphql(
        `query($id:ID!,$loc:ID!){
          productVariant(id:$id){
            id title product { title }
            inventoryItem { id tracked inventoryLevel(locationId:$loc){ quantities(names:["available"]){ name quantity } } }
          }
        }`,
        { id: toGid("ProductVariant", variant_id), loc: locationId },
      );
      const item = v.productVariant?.inventoryItem;
      if (!item) throw new Error("Variante no encontrada.");
      const current: number | null = item.inventoryLevel?.quantities?.[0]?.quantity ?? null;

      if (!item.tracked) {
        const t = await shopify.graphql(
          `mutation($id:ID!){ inventoryItemUpdate(id:$id, input:{tracked:true}){ userErrors { field message } } }`,
          { id: item.id },
        );
        assertNoUserErrors(t.inventoryItemUpdate);
      }

      const summary = {
        product: v.productVariant.product.title,
        variant: v.productVariant.title,
        locationId,
        before: current,
        after: quantity,
      };

      if (!item.inventoryLevel) {
        // La variante aún no tiene stock en esa ubicación: se activa con la cantidad indicada.
        const act = await shopify.graphql(
          `mutation($item:ID!,$loc:ID!,$q:Int){
            inventoryActivate(inventoryItemId:$item, locationId:$loc, available:$q){ userErrors { field message } }
          }`,
          { item: item.id, loc: locationId, q: quantity },
        );
        assertNoUserErrors(act.inventoryActivate);
        return json(summary);
      }

      // Desde la API 2026-04 es obligatorio changeFromQuantity (compare-and-swap) y una clave de idempotencia.
      const key = crypto.randomUUID();
      const data = await shopify.graphql(
        `mutation($input:InventorySetQuantitiesInput!){
          inventorySetQuantities(input:$input) @idempotent(key: "${key}") {
            inventoryAdjustmentGroup { changes { name delta quantityAfterChange } }
            userErrors { field message }
          }
        }`,
        {
          input: {
            name: "available",
            reason: "correction",
            quantities: [
              { inventoryItemId: item.id, locationId, quantity, changeFromQuantity: current },
            ],
          },
        },
      );
      assertNoUserErrors(data.inventorySetQuantities);
      return json(summary);
    }),
  );
}
