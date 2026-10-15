import { z } from "zod";
import { assertNoUserErrors, toGid } from "../shopify.js";
import { json, READ_ONLY, safe, ToolContext, WRITE } from "./util.js";

export function registerContentTools({ server, shopify }: ToolContext): void {
  server.registerTool(
    "shopify_list_pages",
    {
      title: "Listar páginas",
      description: "Lista las páginas de la tienda online (Sobre nosotros, Contacto, FAQ...).",
      inputSchema: { first: z.number().int().min(1).max(100).default(50), after: z.string().optional() },
      annotations: READ_ONLY,
    },
    safe(async ({ first, after }) => {
      const data = await shopify.graphql(
        `query($first:Int!,$after:String){
          pages(first:$first, after:$after){ nodes { id title handle isPublished updatedAt bodySummary } pageInfo { hasNextPage endCursor } }
        }`,
        { first, after },
      );
      return json(data.pages);
    }),
  );

  server.registerTool(
    "shopify_get_page",
    {
      title: "Ver página",
      description: "Contenido HTML completo de una página.",
      inputSchema: { id: z.string() },
      annotations: READ_ONLY,
    },
    safe(async ({ id }) => {
      const data = await shopify.graphql(
        `query($id:ID!){ page(id:$id){ id title handle body isPublished templateSuffix updatedAt } }`,
        { id: toGid("Page", id) },
      );
      if (!data.page) throw new Error("Página no encontrada.");
      return json(data.page);
    }),
  );

  const pageFields = {
    title: z.string().optional(),
    body_html: z.string().optional(),
    handle: z.string().optional(),
    is_published: z.boolean().optional(),
  };

  server.registerTool(
    "shopify_create_page",
    {
      title: "Crear página",
      description: "Crea una página de la tienda online (por defecto sin publicar).",
      inputSchema: { ...pageFields, title: z.string(), is_published: z.boolean().default(false) },
      annotations: WRITE,
    },
    safe(async (a) => {
      const data = await shopify.graphql(
        `mutation($page:PageCreateInput!){ pageCreate(page:$page){ page { id title handle isPublished } userErrors { field message } } }`,
        { page: { title: a.title, body: a.body_html, handle: a.handle, isPublished: a.is_published } },
      );
      assertNoUserErrors(data.pageCreate);
      return json(data.pageCreate.page);
    }),
  );

  server.registerTool(
    "shopify_update_page",
    {
      title: "Editar página",
      description: "Modifica título, contenido HTML, handle o publicación de una página.",
      inputSchema: { id: z.string(), ...pageFields },
      annotations: WRITE,
    },
    safe(async (a) => {
      const data = await shopify.graphql(
        `mutation($id:ID!,$page:PageUpdateInput!){ pageUpdate(id:$id, page:$page){ page { id title handle isPublished updatedAt } userErrors { field message } } }`,
        {
          id: toGid("Page", a.id),
          page: { title: a.title, body: a.body_html, handle: a.handle, isPublished: a.is_published },
        },
      );
      assertNoUserErrors(data.pageUpdate);
      return json(data.pageUpdate.page);
    }),
  );
}
