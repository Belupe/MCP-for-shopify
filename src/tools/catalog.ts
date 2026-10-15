import { z } from "zod";
import { assertNoUserErrors, toGid } from "../shopify.js";
import { json, nodes, READ_ONLY, safe, ToolContext, WRITE } from "./util.js";

export function registerCatalogTools({ server, shopify }: ToolContext): void {
  server.registerTool(
    "shopify_list_collections",
    {
      title: "Listar colecciones",
      description: "Lista colecciones (manuales e inteligentes) con su número de productos.",
      inputSchema: {
        query: z.string().optional(),
        first: z.number().int().min(1).max(100).default(50),
        after: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ query, first, after }) => {
      const data = await shopify.graphql(
        `query($first:Int!,$after:String,$query:String){
          collections(first:$first, after:$after, query:$query, sortKey:TITLE){
            nodes { id title handle updatedAt productsCount { count } ruleSet { appliedDisjunctively } seo { title description } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first, after, query },
      );
      return json(data.collections);
    }),
  );

  server.registerTool(
    "shopify_create_collection",
    {
      title: "Crear colección",
      description: "Crea una colección manual, opcionalmente con productos iniciales.",
      inputSchema: {
        title: z.string(),
        description_html: z.string().optional(),
        handle: z.string().optional(),
        seo: z.object({ title: z.string().optional(), description: z.string().optional() }).optional(),
        product_ids: z.array(z.string()).optional(),
      },
      annotations: WRITE,
    },
    safe(async (a) => {
      const data = await shopify.graphql(
        `mutation($input:CollectionInput!){
          collectionCreate(input:$input){ collection { id title handle productsCount { count } } userErrors { field message } }
        }`,
        {
          input: {
            title: a.title,
            descriptionHtml: a.description_html,
            handle: a.handle,
            seo: a.seo,
            products: a.product_ids?.map((id) => toGid("Product", id)),
          },
        },
      );
      assertNoUserErrors(data.collectionCreate);
      return json(data.collectionCreate.collection);
    }),
  );

  server.registerTool(
    "shopify_update_collection",
    {
      title: "Editar colección",
      description: "Cambia título, descripción, handle o SEO de una colección.",
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        description_html: z.string().optional(),
        handle: z.string().optional(),
        seo: z.object({ title: z.string().optional(), description: z.string().optional() }).optional(),
      },
      annotations: WRITE,
    },
    safe(async (a) => {
      const data = await shopify.graphql(
        `mutation($input:CollectionInput!){
          collectionUpdate(input:$input){ collection { id title handle seo { title description } } userErrors { field message } }
        }`,
        {
          input: {
            id: toGid("Collection", a.id),
            title: a.title,
            descriptionHtml: a.description_html,
            handle: a.handle,
            seo: a.seo,
          },
        },
      );
      assertNoUserErrors(data.collectionUpdate);
      return json(data.collectionUpdate.collection);
    }),
  );

  server.registerTool(
    "shopify_collection_products",
    {
      title: "Añadir o quitar productos de una colección",
      description: "Añade o quita productos de una colección manual.",
      inputSchema: {
        collection_id: z.string(),
        action: z.enum(["add", "remove"]),
        product_ids: z.array(z.string()).min(1).max(250),
      },
      annotations: WRITE,
    },
    safe(async ({ collection_id, action, product_ids }) => {
      const id = toGid("Collection", collection_id);
      const productIds = product_ids.map((p) => toGid("Product", p));
      if (action === "add") {
        const data = await shopify.graphql(
          `mutation($id:ID!,$productIds:[ID!]!){
            collectionAddProductsV2(id:$id, productIds:$productIds){ job { id done } userErrors { field message } }
          }`,
          { id, productIds },
        );
        assertNoUserErrors(data.collectionAddProductsV2);
        return json({ ok: true, job: data.collectionAddProductsV2.job });
      }
      const data = await shopify.graphql(
        `mutation($id:ID!,$productIds:[ID!]!){
          collectionRemoveProducts(id:$id, productIds:$productIds){ job { id done } userErrors { field message } }
        }`,
        { id, productIds },
      );
      assertNoUserErrors(data.collectionRemoveProducts);
      return json({ ok: true, job: data.collectionRemoveProducts.job });
    }),
  );

  server.registerTool(
    "shopify_list_orders",
    {
      title: "Listar pedidos",
      description:
        "Lista pedidos recientes con búsqueda opcional (p. ej. 'financial_status:paid', 'fulfillment_status:unfulfilled', 'created_at:>2026-01-01'). Por defecto Shopify solo da acceso a los últimos 60 días salvo que la app tenga read_all_orders.",
      inputSchema: {
        query: z.string().optional(),
        first: z.number().int().min(1).max(100).default(25),
        after: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ query, first, after }) => {
      const data = await shopify.graphql(
        `query($first:Int!,$after:String,$query:String){
          orders(first:$first, after:$after, query:$query, sortKey:CREATED_AT, reverse:true){
            nodes {
              id name createdAt displayFinancialStatus displayFulfillmentStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              customer { id displayName }
              lineItems(first: 10) { nodes { title quantity sku } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first, after, query },
      );
      return json(data.orders);
    }),
  );

  server.registerTool(
    "shopify_get_order",
    {
      title: "Ver pedido",
      description: "Detalle de un pedido por ID.",
      inputSchema: { id: z.string() },
      annotations: READ_ONLY,
    },
    safe(async ({ id }) => {
      const data = await shopify.graphql(
        `query($id:ID!){
          order(id:$id){
            id name createdAt cancelledAt note tags
            displayFinancialStatus displayFulfillmentStatus
            subtotalPriceSet { shopMoney { amount currencyCode } }
            totalShippingPriceSet { shopMoney { amount currencyCode } }
            totalTaxSet { shopMoney { amount currencyCode } }
            totalPriceSet { shopMoney { amount currencyCode } }
            customer { id displayName defaultEmailAddress { emailAddress } }
            shippingAddress { name city province country zip }
            lineItems(first: 100) { nodes { title variantTitle quantity sku originalUnitPriceSet { shopMoney { amount } } } }
          }
        }`,
        { id: toGid("Order", id) },
      );
      if (!data.order) throw new Error("Pedido no encontrado.");
      return json(data.order);
    }),
  );

  server.registerTool(
    "shopify_list_customers",
    {
      title: "Listar clientes",
      description: "Lista clientes con búsqueda opcional (p. ej. 'country:Spain', 'orders_count:>3').",
      inputSchema: {
        query: z.string().optional(),
        first: z.number().int().min(1).max(100).default(25),
        after: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ query, first, after }) => {
      const data = await shopify.graphql(
        `query($first:Int!,$after:String,$query:String){
          customers(first:$first, after:$after, query:$query, sortKey:UPDATED_AT, reverse:true){
            nodes {
              id displayName numberOfOrders tags createdAt
              amountSpent { amount currencyCode }
              defaultEmailAddress { emailAddress marketingState }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first, after, query },
      );
      return json(data.customers);
    }),
  );

  server.registerTool(
    "shopify_set_metafields",
    {
      title: "Escribir metacampos",
      description: "Crea o actualiza metacampos en cualquier recurso (producto, variante, colección, cliente, tienda...).",
      inputSchema: {
        metafields: z
          .array(
            z.object({
              owner_id: z.string().describe("GID del recurso, p. ej. gid://shopify/Product/123"),
              namespace: z.string(),
              key: z.string(),
              type: z.string().describe("p. ej. single_line_text_field, multi_line_text_field, number_integer, json, boolean"),
              value: z.string(),
            }),
          )
          .min(1)
          .max(25),
      },
      annotations: WRITE,
    },
    safe(async ({ metafields }) => {
      const data = await shopify.graphql(
        `mutation($metafields:[MetafieldsSetInput!]!){
          metafieldsSet(metafields:$metafields){ metafields { id namespace key type value } userErrors { field message } }
        }`,
        {
          metafields: metafields.map((m) => ({
            ownerId: m.owner_id,
            namespace: m.namespace,
            key: m.key,
            type: m.type,
            value: m.value,
          })),
        },
      );
      assertNoUserErrors(data.metafieldsSet);
      return json(nodes({ nodes: data.metafieldsSet.metafields }));
    }),
  );
}
