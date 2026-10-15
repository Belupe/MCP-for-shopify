import fs from "node:fs/promises";
import path from "node:path";

export interface StoredShop {
  shop: string;
  accessToken: string;
  scope: string;
  /** Solo para tokens caducables. Epoch ms. */
  expiresAt?: number;
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
  connectedAt: string;
}

interface CredentialsFile {
  activeShop?: string;
  shops: Record<string, StoredShop>;
}

/** Guarda los tokens en un JSON local con permisos 0600 (solo tu usuario puede leerlo). */
export class CredentialStore {
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = path.join(dir, "credentials.json");
  }

  get path(): string {
    return this.file;
  }

  private async read(): Promise<CredentialsFile> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const data = JSON.parse(raw) as CredentialsFile;
      return { activeShop: data.activeShop, shops: data.shops ?? {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { shops: {} };
      throw err;
    }
  }

  private async write(data: CredentialsFile): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
    await fs.chmod(this.file, 0o600).catch(() => {});
  }

  async list(): Promise<{ activeShop?: string; shops: StoredShop[] }> {
    const data = await this.read();
    return { activeShop: data.activeShop, shops: Object.values(data.shops) };
  }

  async get(shop?: string): Promise<StoredShop | undefined> {
    const data = await this.read();
    const key = shop ?? data.activeShop;
    return key ? data.shops[key] : undefined;
  }

  async save(entry: StoredShop, makeActive = true): Promise<void> {
    const data = await this.read();
    data.shops[entry.shop] = entry;
    if (makeActive || !data.activeShop) data.activeShop = entry.shop;
    await this.write(data);
  }

  async setActive(shop: string): Promise<boolean> {
    const data = await this.read();
    if (!data.shops[shop]) return false;
    data.activeShop = shop;
    await this.write(data);
    return true;
  }

  async remove(shop: string): Promise<boolean> {
    const data = await this.read();
    if (!data.shops[shop]) return false;
    delete data.shops[shop];
    if (data.activeShop === shop) data.activeShop = Object.keys(data.shops)[0];
    await this.write(data);
    return true;
  }
}
