type Env = {
  BASE_DOMAIN: string;
  FALLBACK_SUFFIX: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
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
 * - permitir host "domínio próprio" (qualquer) porque será validado via Supabase (primary_domain)
 *
 * Segurança: aqui só impede lixo óbvio (espaço, barra, etc).
 */
function isHostParamSafe(host: string) {
  if (!host) return false;
  if (host.length > 253) return false;
  if (host.includes("/") || host.includes("\\") || host.includes(" ")) return false;
  return true;
}

/**
 * Resolve tenant baseado no host "real do tenant".
 * - Em produção (Pages + edge host fixo), você deve passar ?host=<tenant-host>
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

  // 1) domínio próprio
  const byDomain = await fetchClubBy(env, "primary_domain", tenantHost);
  if (byDomain) {
    const res = Response.json(byDomain, { headers: { "cache-control": "public, max-age=60" } });
    await cache.put(cacheKey, res.clone());
    return byDomain;
  }

  // 2) fallback por slug (*.borasport.app)
  const slug = extractSlugFromFallbackHost(tenantHost, env.FALLBACK_SUFFIX);
  if (slug) {
    const bySlug = await fetchClubBy(env, "slug", slug);
    if (bySlug) {
      const res = Response.json(bySlug, { headers: { "cache-control": "public, max-age=60" } });
      await cache.put(cacheKey, res.clone());
      return bySlug;
    }
  }

  const res = Response.json(null, { headers: { "cache-control": "public, max-age=30" } });
  await cache.put(cacheKey, res.clone());
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      assertEnv(env);

      const url = new URL(request.url);

      // host do request (normalmente edge.borasport.app em produção)
      const requestHost = normalizeHost(
        request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
      );

      // host real do tenant (vem do web via querystring em produção)
      const hostParam = normalizeHost(url.searchParams.get("host"));
      const tenantHost = hostParam && isHostParamSafe(hostParam) ? hostParam : requestHost;

      if (url.pathname === "/health") return new Response("ok");

      const tenant = await resolveTenantByHost(tenantHost, env);

      if (!tenant) {
        return Response.json({ error: "CLUB_NOT_FOUND", host: tenantHost }, { status: 404 });
      }

      if (url.pathname === "/theme.css") {
        const css = `:root{--club-slug:${tenant.slug};--primary:#0ea5e9;}`;
        return new Response(css, {
          headers: {
            "content-type": "text/css; charset=utf-8",
            "cache-control": "public, max-age=60",
          },
        });
      }

      if (url.pathname === "/manifest.webmanifest") {
        const manifest = {
          name: `Bora — ${tenant.slug}`,
          short_name: `Bora`,
          start_url: "/",
          display: "standalone",
          background_color: "#ffffff",
          theme_color: "#0ea5e9",
        };

        return Response.json(manifest, {
          headers: {
            "content-type": "application/manifest+json; charset=utf-8",
            "cache-control": "public, max-age=60",
          },
        });
      }

      return Response.json({ ok: true, requestHost, tenantHost, tenant });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return Response.json({ error: "EDGE_INTERNAL_ERROR", message }, { status: 500 });
    }
  },
};
