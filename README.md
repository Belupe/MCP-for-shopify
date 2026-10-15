# MCP for Shopify

Servidor **MCP local** para que Claude (Claude Desktop, Claude Code o cualquier cliente MCP) **administre tu tienda Shopify**: leer y modificar productos, precios, stock, colecciones, páginas, metacampos, consultar pedidos y clientes, y auditar el catálogo para proponerte mejoras.

- 🖥️ **Todo en tu ordenador**: el servidor corre por `stdio` y el inicio de sesión usa `http://localhost`. No hace falta hosting ni túneles.
- 🔐 **Inicio de sesión con tu cuenta de Shopify**: la primera vez, Claude abre el navegador, entras en Shopify, pulsas *Instalar* y listo. El token se guarda en `~/.config/mcp-for-shopify/credentials.json` con permisos `600`.
- 🏪 **Varias tiendas**: puedes conectar varias y cambiar entre ellas.

## Cómo funciona el login

```
Claude ──(shopify_login "mi-tienda")──► MCP local
                                         │ 1. levanta un servidor temporal en 127.0.0.1:3457
                                         │ 2. abre el navegador en mi-tienda.myshopify.com/admin/oauth/authorize
Navegador: inicias sesión en Shopify y apruebas los permisos
                                         │ 3. Shopify redirige a http://localhost:3457/auth/callback?code=…
                                         │ 4. se verifica state + HMAC y se cambia el code por un token
                                         └ 5. token guardado en local → Claude ya puede trabajar
```

## 1. Crear tu app de Shopify (una sola vez, ~5 min)

Shopify exige que cualquier integración sea una "app" con su Client ID y su secreto. Es gratis.

1. Entra en el **Dev Dashboard** de Shopify: <https://dev.shopify.com/dashboard> (con la misma cuenta que administra la tienda, o como *Partner*).
2. **Create app** → ponle un nombre, por ejemplo `Claude MCP`.
3. En la configuración de la versión de la app (**Versions → Create version**, o *Configuration* según tu panel):
   - **App URL**: `http://localhost:3457`
   - **Redirect URLs / Allowed redirection URL(s)**: `http://localhost:3457/auth/callback`
   - **Scopes** (permisos): los mismos que se piden por defecto:
     `read_products, write_products, read_inventory, write_inventory, read_locations, read_orders, read_customers, write_customers, read_content, write_content`
   - Si aparece la opción **Use legacy install flow**, actívala (el MCP usa el flujo OAuth clásico).
   - Guarda y **publica (Release)** la versión.
4. En **Settings** copia el **Client ID** y el **Client secret**.
5. **Distribución**: si la tienda no pertenece a la misma organización que la app, en *Distribution* elige **Custom distribution** e indica el dominio `*.myshopify.com` de la tienda.

> Si cambias el puerto con `SHOPIFY_REDIRECT_PORT`, cambia también la Redirect URL de la app.

## 2. Instalar el MCP

Requiere **Node.js 18.17 o superior**.

```bash
git clone https://github.com/belupe/mcp-for-shopify.git
cd mcp-for-shopify
npm install
npm run build
```

## 3. Conectarlo a Claude

### Claude Desktop

Edita `claude_desktop_config.json` (Ajustes → Desarrollador → Editar configuración):

```json
{
  "mcpServers": {
    "shopify": {
      "command": "node",
      "args": ["/RUTA/ABSOLUTA/mcp-for-shopify/dist/index.js"],
      "env": {
        "SHOPIFY_CLIENT_ID": "tu_client_id",
        "SHOPIFY_CLIENT_SECRET": "tu_client_secret"
      }
    }
  }
}
```

Reinicia Claude Desktop.

### Claude Code

```bash
claude mcp add shopify \
  -e SHOPIFY_CLIENT_ID=tu_client_id \
  -e SHOPIFY_CLIENT_SECRET=tu_client_secret \
  -- node /RUTA/ABSOLUTA/mcp-for-shopify/dist/index.js
```

## 4. Úsalo

Simplemente pídeselo a Claude:

> «Conéctate a mi tienda **mi-tienda.myshopify.com**»

Se abrirá el navegador, inicias sesión en Shopify y apruebas. A partir de ahí:

> «Haz una auditoría de mi catálogo y dime qué mejorarías»
> «Reescribe las descripciones de los productos sin descripción y ponles meta descripción SEO»
> «Sube un 10 % el precio de todos los productos de la colección Verano»
> «Pon a 0 el stock de la camiseta azul talla M»
> «Crea una página de Preguntas frecuentes»

Claude te enseñará lo que va a cambiar antes de hacer cambios masivos o borrados.

## Herramientas incluidas

| Área | Herramientas |
|---|---|
| Sesión | `shopify_login`, `shopify_auth_status`, `shopify_list_stores`, `shopify_switch_store`, `shopify_logout`, `shopify_shop_info` |
| Productos | `shopify_list_products`, `shopify_get_product`, `shopify_create_product`, `shopify_update_product`, `shopify_delete_product`, `shopify_update_variants`, `shopify_add_product_images` |
| Inventario | `shopify_list_locations`, `shopify_set_inventory` |
| Colecciones | `shopify_list_collections`, `shopify_create_collection`, `shopify_update_collection`, `shopify_collection_products` |
| Pedidos y clientes (lectura) | `shopify_list_orders`, `shopify_get_order`, `shopify_list_customers` |
| Contenido | `shopify_list_pages`, `shopify_get_page`, `shopify_create_page`, `shopify_update_page`, `shopify_set_metafields` |
| Mejora | `shopify_store_audit` (imágenes sin alt, SEO vacío, descripciones pobres, sin stock, sin SKU, precios incoherentes…) |
| Avanzado | `shopify_graphql`: cualquier consulta/mutación de la Admin GraphQL API (descuentos, menús, blogs, traducciones…) |

## Configuración opcional

| Variable | Por defecto | Para qué |
|---|---|---|
| `SHOPIFY_REDIRECT_PORT` | `3457` | Puerto local del callback OAuth |
| `SHOPIFY_SCOPES` | ver arriba | Permisos que se piden (añade p. ej. `write_discounts`, `read_all_orders`… y declara los mismos en la app) |
| `SHOPIFY_API_VERSION` | `2026-07` | Versión de la Admin API |
| `MCP_SHOPIFY_CONFIG_DIR` | `~/.config/mcp-for-shopify` | Dónde se guardan los tokens |

## Seguridad

- El servidor de callback solo escucha en `127.0.0.1` y solo mientras hay un login en curso (máx. 10 min).
- Se valida el `state` (anti-CSRF), la firma **HMAC** de Shopify y que el dominio sea `*.myshopify.com` antes de enviar el secreto.
- Los tokens se guardan solo en tu equipo (`chmod 600`). `shopify_logout` los borra; para revocar el acceso del todo, desinstala la app desde el admin de Shopify.
- No subas tu `SHOPIFY_CLIENT_SECRET` a ningún repositorio.

## Desarrollo

```bash
npm run build   # compila a dist/
npm test        # tests (OAuth simulado + arranque del servidor MCP)
```

## Problemas frecuentes

- **`redirect_uri is not whitelisted`**: la Redirect URL de la app no coincide exactamente con `http://localhost:3457/auth/callback`, o no publicaste la versión.
- **Puerto ocupado**: cambia `SHOPIFY_REDIRECT_PORT` y la Redirect URL de la app.
- **401 al usar herramientas**: la app se desinstaló o el token se revocó; vuelve a pedir a Claude que inicie sesión.
- **Error de permisos (`access denied`)** en una herramienta: falta ese scope; añádelo en la app y en `SHOPIFY_SCOPES`, y vuelve a hacer login.
