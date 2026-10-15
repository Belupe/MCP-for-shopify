import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { AppConfig, isValidShopDomain, redirectUri } from "./config.js";
import { CredentialStore, StoredShop } from "./store.js";

/** Tiempo máximo que el servidor local espera a que el usuario termine el login. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export type LoginState =
  | { status: "idle" }
  | { status: "pending"; shop: string; authorizeUrl: string; startedAt: number }
  | { status: "success"; shop: string; scope: string }
  | { status: "error"; shop?: string; message: string };

/**
 * Verifica la firma HMAC que Shopify añade a la URL del callback.
 * Se firma la query sin el parámetro `hmac`, ordenada alfabéticamente.
 */
export function verifyShopifyHmac(params: URLSearchParams, secret: string): boolean {
  const hmac = params.get("hmac");
  if (!hmac) return false;
  const message = [...params.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(hmac, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function buildAuthorizeUrl(config: AppConfig, shop: string, state: string): string {
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", config.clientId!);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("redirect_uri", redirectUri(config));
  url.searchParams.set("state", state);
  return url.toString();
}

export function openInBrowser(url: string): boolean {
  try {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

interface TokenResponse {
  access_token: string;
  scope: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

function toStored(shop: string, body: TokenResponse): StoredShop {
  const now = Date.now();
  return {
    shop,
    accessToken: body.access_token,
    scope: body.scope,
    expiresAt: body.expires_in ? now + body.expires_in * 1000 : undefined,
    refreshToken: body.refresh_token,
    refreshTokenExpiresAt: body.refresh_token_expires_in
      ? now + body.refresh_token_expires_in * 1000
      : undefined,
    connectedAt: new Date(now).toISOString(),
  };
}

async function postToken(shop: string, payload: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify rechazó el intercambio de token (${res.status}): ${text}`);
  const body = JSON.parse(text) as TokenResponse;
  if (!body.access_token) throw new Error("Shopify no devolvió access_token.");
  return body;
}

export async function refreshAccessToken(config: AppConfig, entry: StoredShop): Promise<StoredShop> {
  if (!entry.refreshToken) throw new Error("El token ha caducado y no hay refresh token.");
  if (!config.clientId || !config.clientSecret) {
    throw new Error("Faltan SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET para renovar el token.");
  }
  const body = await postToken(entry.shop, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: entry.refreshToken,
  });
  return toStored(entry.shop, body);
}

const page = (title: string, msg: string) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5}</style>
</head><body><h1>${title}</h1><p>${msg}</p></body></html>`;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Gestiona el flujo OAuth "authorization code" de Shopify con un servidor HTTP
 * efímero en localhost que recibe el callback.
 */
export class LoginManager {
  private state: LoginState = { status: "idle" };
  private server?: http.Server;
  private timer?: NodeJS.Timeout;
  private expectedState?: string;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly config: AppConfig,
    private readonly store: CredentialStore,
  ) {}

  get current(): LoginState {
    return this.state;
  }

  /** Arranca el login. Devuelve la URL que el usuario debe abrir. */
  async start(shop: string): Promise<string> {
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new Error(
        "Faltan SHOPIFY_CLIENT_ID y SHOPIFY_CLIENT_SECRET. Crea una app en el Dev Dashboard de Shopify y añádelos a la configuración del MCP (ver README).",
      );
    }
    await this.closeServer();
    this.expectedState = crypto.randomBytes(16).toString("hex");
    const authorizeUrl = buildAuthorizeUrl(this.config, shop, this.expectedState);
    await this.listen(shop);
    this.state = { status: "pending", shop, authorizeUrl, startedAt: Date.now() };
    this.timer = setTimeout(() => {
      this.finish({ status: "error", shop, message: "Se agotó el tiempo para completar el inicio de sesión." });
    }, LOGIN_TIMEOUT_MS);
    this.timer.unref();
    return authorizeUrl;
  }

  /** Espera a que termine el login o a que pase `ms`. */
  async waitFor(ms: number): Promise<LoginState> {
    if (this.state.status !== "pending") return this.state;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
    return this.state;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    void this.closeServer();
  }

  private closeServer(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private finish(state: LoginState): void {
    this.state = state;
    this.expectedState = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Cerramos un poco después para que el navegador reciba la respuesta
    // (si se inicia otro login antes, start() lo cierra al momento).
    const server = this.server;
    setTimeout(() => {
      if (this.server === server) void this.closeServer();
    }, 500).unref();
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w());
  }

  private listen(shop: string): Promise<void> {
    const server = http.createServer((req, res) => {
      void this.handle(shop, req, res);
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        reject(
          err.code === "EADDRINUSE"
            ? new Error(
                `El puerto ${this.config.redirectPort} está ocupado. Cambia SHOPIFY_REDIRECT_PORT (y la Redirect URL de tu app) o cierra el proceso que lo usa.`,
              )
            : err,
        );
      });
      // Solo escuchamos en la interfaz loopback: nada queda expuesto a la red.
      server.listen(this.config.redirectPort, "127.0.0.1", () => resolve());
    });
  }

  private async handle(shop: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${this.config.redirectPort}`);
    if (url.pathname !== "/auth/callback") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("No encontrado");
      return;
    }
    const send = (code: number, title: string, msg: string) =>
      res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" }).end(page(title, msg));

    if (this.state.status !== "pending" || !this.expectedState) {
      send(400, "Sin inicio de sesión en curso", "Vuelve a pedirle a Claude que inicie sesión en Shopify.");
      return;
    }
    const params = url.searchParams;
    const returnedShop = params.get("shop") ?? "";
    const code = params.get("code");

    let error: string | undefined;
    if (params.get("state") !== this.expectedState) error = "El parámetro state no coincide (posible CSRF).";
    else if (!verifyShopifyHmac(params, this.config.clientSecret!)) error = "La firma HMAC de Shopify no es válida.";
    else if (!isValidShopDomain(returnedShop)) error = "Dominio de tienda inválido.";
    else if (returnedShop !== shop) error = `Se autorizó ${returnedShop} pero se esperaba ${shop}.`;
    else if (!code) error = "Shopify no devolvió el código de autorización.";

    if (error) {
      send(400, "Error al iniciar sesión", escapeHtml(error));
      this.finish({ status: "error", shop, message: error });
      return;
    }

    try {
      const body = await postToken(shop, {
        client_id: this.config.clientId!,
        client_secret: this.config.clientSecret!,
        code: code!,
      });
      const entry = toStored(shop, body);
      await this.store.save(entry);
      send(
        200,
        "¡Tienda conectada!",
        `La tienda <b>${escapeHtml(shop)}</b> ya está conectada. Puedes cerrar esta pestaña y volver con Claude.`,
      );
      this.finish({ status: "success", shop, scope: entry.scope });
    } catch (err) {
      const message = (err as Error).message;
      send(500, "Error al obtener el token", escapeHtml(message));
      this.finish({ status: "error", shop, message });
    }
  }
}
