type Env = {
  BASE_DOMAIN: string;
  FALLBACK_SUFFIX: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  PAGES_ORIGIN?: string;
};

type Tenant = {
  club_id: string;
  slug: string;
  primary_domain?: string | null;
};

function normalizeHost(raw: string | null) {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .split(",")[0]
    .trim()
    .replace(/^www\./, "")
    .replace(/:\d+$/, "");
}

function extractSlugFromFallbackHost(host: string, suffix: string) {
  if (!host || !suffix) return null;
  if (!host.endsWith(suffix)) return null;
  const slug = host.slice(0, -suffix.length);
  if (!slug) return null;
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  return slug;
}

function assertEnv(env: Env) {
  const missing: string[] = [];
  if (!env.BASE_DOMAIN) missing.push("BASE_DOMAIN");
  if (!env.FALLBACK_SUFFIX) missing.push("FALLBACK_SUFFIX");
  if (!env.SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!env.SUPABASE_ANON_KEY) missing.push("SUPABASE_ANON_KEY");
  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }
}

function buildSupabaseRestUrl(env: Env, path: string) {
  const base = env.SUPABASE_URL.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function fetchClubBy(
  env: Env,
  field: "primary_domain" | "slug",
  value: string,
): Promise<Tenant | null> {
  const url = new URL(buildSupabaseRestUrl(env, "/rest/v1/clubs"));
  url.searchParams.set("select", "id,slug,primary_domain");
  url.searchParams.set(field, `eq.${value}`);
  url.searchParams.set("limit", "1");

  const resp = await fetch(url.toString(), {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      Accept: "application/vnd.pgrst.object+json",
    },
  });

  if (resp.status === 404) return null;
  if (resp.status === 406) return null;

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Supabase REST error (${resp.status}) fetching clubs by ${field}. Body: ${text.slice(0, 500)}`,
    );
  }

  const data = (await resp.json()) as {
    id: string;
    slug: string;
    primary_domain: string | null;
  };

  return {
    club_id: data.id,
    slug: data.slug,
    primary_domain: data.primary_domain,
  };
}

/**
 * Valida o host recebido via querystring.
 * Regras:
 * - permitir hosts do wildcard *.borasport.app
 * - permitir host "domínio próprio" porque será validado via Supabase (primary_domain)
 *
 * Segurança: só bloqueia lixo óbvio.
 */
function isHostParamSafe(host: string) {
  if (!host) return false;
  if (host.length > 253) return false;
  if (host.includes("/") || host.includes("\\") || host.includes(" ")) return false;
  return true;
}

/**
 * Resolve tenant baseado no host real do tenant.
 * - Em produção (Pages + edge host fixo), passar ?host=<tenant-host>
 * - Em dev/local, pode cair no host do request mesmo
 */
async function resolveTenantByHost(tenantHost: string, env: Env): Promise<Tenant | null> {
  if (!tenantHost) return null;

  const cacheKey = new Request(
    `https://tenant-resolver.local/resolve?host=${encodeURIComponent(tenantHost)}`,
  );

  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    return (await cached.json()) as Tenant | null;
  }

  const byDomain = await fetchClubBy(env, "primary_domain", tenantHost);
  if (byDomain) {
    const res = Response.json(byDomain, {
      headers: { "cache-control": "public, max-age=60" },
    });
    await cache.put(cacheKey, res.clone());
    return byDomain;
  }

  const slug = extractSlugFromFallbackHost(tenantHost, env.FALLBACK_SUFFIX);
  if (slug) {
    const bySlug = await fetchClubBy(env, "slug", slug);
    if (bySlug) {
      const res = Response.json(bySlug, {
        headers: { "cache-control": "public, max-age=60" },
      });
      await cache.put(cacheKey, res.clone());
      return bySlug;
    }
  }

  const res = Response.json(null, {
    headers: { "cache-control": "public, max-age=30" },
  });
  await cache.put(cacheKey, res.clone());
  return null;
}

function buildThemeCss(tenant: Tenant) {
  return `:root{--club-slug:${tenant.slug};--primary:#0ea5e9;}`;
}

function buildManifest(tenant: Tenant) {
  return {
    name: `Bora — ${tenant.slug}`,
    short_name: "Bora",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0ea5e9",
  };
}

function withVaryHost(headers: Headers) {
  const current = headers.get("Vary");
  if (!current) {
    headers.set("Vary", "Host");
    return;
  }

  const values = current
    .split(",")
    .map((v) => v.trim().toLowerCase());

  if (!values.includes("host")) {
    headers.set("Vary", `${current}, Host`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      assertEnv(env);

      const url = new URL(request.url);

      const requestHost = normalizeHost(
        request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
      );

      const hostParam = normalizeHost(url.searchParams.get("host"));
      const tenantHost = hostParam && isHostParamSafe(hostParam) ? hostParam : requestHost;

      if (url.pathname === "/health") {
        return new Response("ok", {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }

      const tenant = await resolveTenantByHost(tenantHost, env);

      if (!tenant) {
        return Response.json(
          { error: "CLUB_NOT_FOUND", host: tenantHost },
          {
            status: 404,
            headers: {
              "cache-control": "public, max-age=30",
              "content-type": "application/json; charset=utf-8",
            },
          },
        );
      }

      if (url.pathname === "/theme.css") {
        return new Response(buildThemeCss(tenant), {
          headers: {
            "content-type": "text/css; charset=utf-8",
            "cache-control": "public, max-age=60",
            "vary": "Host",
          },
        });
      }

      if (url.pathname === "/manifest.webmanifest") {
        return new Response(JSON.stringify(buildManifest(tenant)), {
          headers: {
            "content-type": "application/manifest+json; charset=utf-8",
            "cache-control": "public, max-age=60",
            "vary": "Host",
          },
        });
      }

      const pagesOrigin = (env.PAGES_ORIGIN || "https://borasport.pages.dev").replace(/\/+$/, "");
      const pagesUrl = new URL(pagesOrigin);
      const proxyUrl = new URL(request.url);

      proxyUrl.protocol = pagesUrl.protocol;
      proxyUrl.hostname = pagesUrl.hostname;
      proxyUrl.port = pagesUrl.port;

      const proxyHeaders = new Headers(request.headers);
      proxyHeaders.set("host", pagesUrl.hostname);
      proxyHeaders.set("x-forwarded-host", tenantHost);
      proxyHeaders.set("x-borasport-tenant-host", tenantHost);
      proxyHeaders.set("x-borasport-tenant-slug", tenant.slug);

      const proxiedRequest = new Request(proxyUrl.toString(), {
        method: request.method,
        headers: proxyHeaders,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });

      const response = await fetch(proxiedRequest);

      const responseHeaders = new Headers(response.headers);
      withVaryHost(responseHeaders);

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return Response.json(
        { error: "EDGE_INTERNAL_ERROR", message },
        { status: 500 },
      );
    }
  },
};
