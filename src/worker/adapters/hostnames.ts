// Zeiko S3 addresses of their own (ADR-048), through the Cloudflare API with CF_HOSTNAMES_TOKEN:
// s3.<name>.<zone> is a Worker custom domain (Cloudflare makes the DNS record and the certificate);
// a person's own domain is a Cloudflare for SaaS custom hostname plus a Worker route for it, and
// goes active once its CNAME points at the zone's fallback origin. `MockHostnames` for dev and tests.

export interface DnsRecord {
  type: 'CNAME' | 'TXT';
  name: string;
  value: string;
}

export interface CustomHostnameState {
  status: 'pending' | 'active' | 'failed';
  records: DnsRecord[];
  error: string | null;
}

export class HostnameError extends Error {
  constructor(
    message: string,
    readonly taken = false,
  ) {
    super(message);
  }
}

export interface Hostnames {
  readonly name: string;
  /** s3.<name>.<zone>: a custom domain of this Worker. Returns its id. */
  addZeikoHostname(hostname: string): Promise<string>;
  removeZeikoHostname(id: string): Promise<void>;
  /** A person's own domain: a custom hostname and a route to this Worker. */
  addCustomHostname(
    hostname: string,
    cnameTarget: string,
  ): Promise<{ id: string; routeId: string } & CustomHostnameState>;
  customHostname(id: string, hostname: string, cnameTarget: string): Promise<CustomHostnameState>;
  removeCustomHostname(id: string, routeId: string | null): Promise<void>;
}

const API = 'https://api.cloudflare.com/client/v4';

interface CfResponse<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

interface CfCustomHostname {
  id: string;
  status: string;
  verification_errors?: string[];
  ownership_verification?: { type: string; name: string; value: string };
  ssl?: { status?: string; validation_errors?: Array<{ message: string }> };
}

export class CloudflareHostnames implements Hostnames {
  readonly name = 'cloudflare';
  constructor(
    private token: string,
    private accountId: string,
    private zoneId: string,
    private workerName: string,
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetcher(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
    });
    const body = (await res.json().catch(() => null)) as CfResponse<T> | null;
    if (!res.ok || !body?.success) {
      const message =
        body?.errors?.map((e) => `${e.code} ${e.message}`).join('; ') ?? `HTTP ${res.status}`;
      // Already a DNS record / custom hostname / route for that name.
      const taken = /already exists|duplicate|conflict|in use/i.test(message);
      throw new HostnameError(`Cloudflare: ${message}`, taken);
    }
    return body.result;
  }

  async addZeikoHostname(hostname: string): Promise<string> {
    // The PUT below would move a custom domain another Worker already has; never take one over.
    const existing = await this.call<Array<{ hostname: string }>>(
      `/accounts/${this.accountId}/workers/domains?hostname=${encodeURIComponent(hostname)}`,
    );
    if (existing.some((d) => d.hostname === hostname))
      throw new HostnameError(`Cloudflare: ${hostname} is already a custom domain`, true);
    const r = await this.call<{ id: string }>(`/accounts/${this.accountId}/workers/domains`, {
      method: 'PUT',
      body: JSON.stringify({
        environment: 'production',
        hostname,
        service: this.workerName,
        zone_id: this.zoneId,
      }),
    });
    return r.id;
  }

  async removeZeikoHostname(id: string): Promise<void> {
    await this.call(`/accounts/${this.accountId}/workers/domains/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  private state(h: CfCustomHostname, hostname: string, cnameTarget: string): CustomHostnameState {
    const records: DnsRecord[] = [{ type: 'CNAME', name: hostname, value: cnameTarget }];
    if (h.ownership_verification?.type === 'txt')
      records.push({
        type: 'TXT',
        name: h.ownership_verification.name,
        value: h.ownership_verification.value,
      });
    const ssl = h.ssl?.status ?? 'pending';
    if (h.status === 'active' && ssl === 'active')
      return { status: 'active', records, error: null };
    if (['blocked', 'moved', 'deleted'].includes(h.status) || /timed_out|failed/.test(ssl))
      return {
        status: 'failed',
        records,
        error:
          [
            ...(h.verification_errors ?? []),
            ...(h.ssl?.validation_errors ?? []).map((e) => e.message),
          ].join('; ') || `${h.status} / ${ssl}`,
      };
    return { status: 'pending', records, error: h.verification_errors?.[0] ?? null };
  }

  async addCustomHostname(hostname: string, cnameTarget: string) {
    const h = await this.call<CfCustomHostname>(`/zones/${this.zoneId}/custom_hostnames`, {
      method: 'POST',
      body: JSON.stringify({
        hostname,
        ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } },
      }),
    });
    try {
      const route = await this.call<{ id: string }>(`/zones/${this.zoneId}/workers/routes`, {
        method: 'POST',
        body: JSON.stringify({ pattern: `${hostname}/*`, script: this.workerName }),
      });
      return { id: h.id, routeId: route.id, ...this.state(h, hostname, cnameTarget) };
    } catch (e) {
      await this.removeCustomHostname(h.id, null).catch(() => undefined);
      throw e;
    }
  }

  async customHostname(id: string, hostname: string, cnameTarget: string) {
    const h = await this.call<CfCustomHostname>(
      `/zones/${this.zoneId}/custom_hostnames/${encodeURIComponent(id)}`,
    );
    return this.state(h, hostname, cnameTarget);
  }

  async removeCustomHostname(id: string, routeId: string | null): Promise<void> {
    if (routeId)
      await this.call(`/zones/${this.zoneId}/workers/routes/${encodeURIComponent(routeId)}`, {
        method: 'DELETE',
      });
    await this.call(`/zones/${this.zoneId}/custom_hostnames/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
}

/**
 * Dev and tests: every name can be had, a custom domain starts pending (with the CNAME to add) and
 * is active the first time it is looked at again, as if its CNAME had been added meanwhile.
 */
export class MockHostnames implements Hostnames {
  readonly name = 'mock';
  addZeikoHostname(hostname: string): Promise<string> {
    return Promise.resolve(`mock-domain:${hostname}`);
  }
  removeZeikoHostname(): Promise<void> {
    return Promise.resolve();
  }
  addCustomHostname(hostname: string, cnameTarget: string) {
    return Promise.resolve({
      id: `mock-hostname:${hostname}`,
      routeId: `mock-route:${hostname}`,
      status: 'pending' as const,
      records: [{ type: 'CNAME' as const, name: hostname, value: cnameTarget }],
      error: null,
    });
  }
  customHostname(_id: string, hostname: string, cnameTarget: string) {
    return Promise.resolve({
      status: 'active' as const,
      records: [{ type: 'CNAME' as const, name: hostname, value: cnameTarget }],
      error: null,
    });
  }
  removeCustomHostname(): Promise<void> {
    return Promise.resolve();
  }
}
