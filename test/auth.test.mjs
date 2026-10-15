import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeShop, loadConfig } from "../dist/config.js";
import { verifyShopifyHmac, LoginManager } from "../dist/auth.js";
import { CredentialStore } from "../dist/store.js";
import { ShopifyClient } from "../dist/shopify.js";

const SECRET = "shhh";

function sign(params) {
  const msg = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  params.set("hmac", crypto.createHmac("sha256", SECRET).update(msg).digest("hex"));
  return params;
}

test("normalizeShop acepta formatos comunes y rechaza dominios ajenos", () => {
  assert.equal(normalizeShop("mi-tienda"), "mi-tienda.myshopify.com");
  assert.equal(normalizeShop("https://Mi-Tienda.myshopify.com/admin"), "mi-tienda.myshopify.com");
  assert.equal(normalizeShop("https://admin.shopify.com/store/mi-tienda/products"), "mi-tienda.myshopify.com");
  assert.throws(() => normalizeShop("evil.com"));
  assert.throws(() => normalizeShop("mi-tienda.myshopify.com.evil.com"));
});

test("verifyShopifyHmac", () => {
  const p = sign(new URLSearchParams({ code: "abc", shop: "a.myshopify.com", state: "s", timestamp: "1" }));
  assert.ok(verifyShopifyHmac(p, SECRET));
  p.set("code", "tampered");
  assert.ok(!verifyShopifyHmac(p, SECRET));
});

test("flujo OAuth completo: callback local -> token guardado -> llamada GraphQL", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-shopify-"));
  const config = loadConfig({
    SHOPIFY_CLIENT_ID: "cid",
    SHOPIFY_CLIENT_SECRET: SECRET,
    SHOPIFY_REDIRECT_PORT: "34571",
    MCP_SHOPIFY_CONFIG_DIR: dir,
  });
  const store = new CredentialStore(dir);
  const login = new LoginManager(config, store);

  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")) return realFetch(url, init);
    calls.push({ url, init });
    if (url === "https://demo.myshopify.com/admin/oauth/access_token") {
      const body = JSON.parse(init.body);
      assert.deepEqual(body, { client_id: "cid", client_secret: SECRET, code: "the-code" });
      return new Response(JSON.stringify({ access_token: "shpat_x", scope: "read_products" }), { status: 200 });
    }
    if (url.endsWith("/graphql.json")) {
      assert.equal(init.headers["X-Shopify-Access-Token"], "shpat_x");
      return new Response(JSON.stringify({ data: { shop: { name: "Demo" } } }), { status: 200 });
    }
    throw new Error("unexpected " + url);
  };
  t.after(() => { globalThis.fetch = realFetch; login.stop(); });

  const authUrl = new URL(await login.start("demo.myshopify.com"));
  assert.equal(authUrl.host, "demo.myshopify.com");
  assert.equal(authUrl.searchParams.get("redirect_uri"), "http://localhost:34571/auth/callback");
  const state = authUrl.searchParams.get("state");

  // State incorrecto -> rechazado
  const bad = sign(new URLSearchParams({ code: "the-code", shop: "demo.myshopify.com", state: "nope", timestamp: "1" }));
  let res = await realFetch(`http://127.0.0.1:34571/auth/callback?${bad}`);
  assert.equal(res.status, 400);
  assert.equal(login.current.status, "error");

  // Reintento correcto
  const authUrl2 = new URL(await login.start("demo.myshopify.com"));
  const state2 = authUrl2.searchParams.get("state");
  assert.notEqual(state, state2);
  const waiting = login.waitFor(5000);
  const ok = sign(new URLSearchParams({ code: "the-code", shop: "demo.myshopify.com", state: state2, timestamp: "1" }));
  res = await realFetch(`http://127.0.0.1:34571/auth/callback?${ok}`);
  assert.equal(res.status, 200);
  const final = await waiting;
  assert.equal(final.status, "success");

  const saved = await store.get();
  assert.equal(saved.accessToken, "shpat_x");
  const stat = await fs.stat(store.path);
  assert.equal(stat.mode & 0o777, 0o600);

  const client = new ShopifyClient(config, store);
  const data = await client.graphql("{ shop { name } }");
  assert.equal(data.shop.name, "Demo");
});
