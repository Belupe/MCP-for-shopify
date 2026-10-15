import { AppConfig } from "./config.js";
import { refreshAccessToken } from "./auth.js";
import { CredentialStore, StoredShop } from "./store.js";

export class NotConnectedError extends Error {
  constructor() {
    super(
      "No hay ninguna tienda de Shopify conectada. Usa la herramienta shopify_login con el dominio de tu tienda (por ejemplo: mi-tienda.myshopify.com).",
    );
  }
}

export class ShopifyApiError extends Error {}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number; restoreRate: number } } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Cliente mínimo de la Admin GraphQL API usando la tienda activa. */
export class ShopifyClient {
  constructor(
    private readonly config: AppConfig,
    private readonly store: CredentialStore,
  ) {}

  async session(): Promise<StoredShop> {
    let entry = await this.store.get();
    if (!entry) throw new NotConnectedError();
    // Renueva tokens caducables con 60 s de margen.
    if (entry.expiresAt && entry.expiresAt - 60_000 < Date.now()) {
      entry = await refreshAccessToken(this.config, entry);
      await this.store.save(entry);
    }
    return entry;
  }

  async graphql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const session = await this.session();
    const url = `https://${session.shop}/admin/api/${this.config.apiVersion}/graphql.json`;

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Shopify-Access-Token": session.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (res.status === 401) {
        throw new ShopifyApiError(
          `Shopify rechazó el token de ${session.shop} (401). Puede que la app se haya desinstalado: vuelve a usar shopify_login.`,
        );
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(Number(res.headers.get("Retry-After") ?? 0) * 1000 || 1000 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new ShopifyApiError(`Error HTTP ${res.status} de Shopify: ${text.slice(0, 1000)}`);

      const body = JSON.parse(text) as GraphQLResponse<T>;
      const throttled = body.errors?.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled && attempt < 3) {
        const status = body.extensions?.cost?.throttleStatus;
        await sleep(status ? Math.ceil(1000 / Math.max(status.restoreRate, 1)) * 50 : 2000);
        continue;
      }
      if (body.errors?.length) {
        throw new ShopifyApiError(`Errores GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
      }
      return body.data as T;
    }
  }
}

/** Lanza un error legible si una mutación devuelve userErrors. */
export function assertNoUserErrors(payload: { userErrors?: Array<{ field?: string[] | null; message: string }> } | null | undefined): void {
  const errors = payload?.userErrors ?? [];
  if (errors.length) {
    throw new ShopifyApiError(
      errors.map((e) => (e.field?.length ? `${e.field.join(".")}: ${e.message}` : e.message)).join("; "),
    );
  }
}

/** Acepta un ID numérico o un GID y devuelve el GID. */
export function toGid(type: string, id: string | number): string {
  const s = String(id).trim();
  if (s.startsWith("gid://")) return s;
  if (!/^\d+$/.test(s)) throw new Error(`ID de ${type} inválido: ${s}`);
  return `gid://shopify/${type}/${s}`;
}
