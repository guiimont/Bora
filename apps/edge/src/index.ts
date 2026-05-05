type Env = {
  BASE_DOMAIN: string;
  FALLBACK_SUFFIX: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  PAGES_ORIGIN: string;
};

type Tenant = {
  club_id: string;
  slug: string;
  name?: string;
  primary_domain?: string | null;
  primary_color?: string | null;
  secondary_color?: string | null;
  logo_url?: string | null;
  manifest_icon_url?: string | null;
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
  if (!host.endsWith(suffix)) return null;
  const slug = host.slice(0, -suffix.length);
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  return slug;
}

function buildSupabaseUrl(env: Env, path: string) {
  return `${env.SUPABASE_URL.replace(/\/$/, "")}${path}`;
}

async function fetchClubBy(
  env: Env,
  field: "primary_domain" | "slug",
  value: string
): Promise<Tenant | null> {
  const url = new URL(buildSupabaseUrl(env, "/rest/v1/clubs"));
  url.searchParams.set(
    "select",
    "id,slug,name,primary_domain,primary_color,secondary_color,logo_url,manifest_icon_url"
  );
  url.searchParams.set(field, `eq.${value}`);
  url.searchParams.set("limit", "1");

  const resp = await fetch(url.toString(), {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      Accept: "application/vnd.pgrst.object+json",
    },
  });

  if (!resp.ok) return null;

  const data = await resp.json();

  return {
    club_id: data.id,
    slug: data.slug,
    name: data.name,
    primary_domain: data.primary_domain,
    primary_color: data.primary_color,
    secondary_color: data.secondary_color,
    logo_url: data.logo_url,
    manifest_icon_url: data.manifest_icon_url,
  };
}

async function resolveTenant(host: string, env: Env): Promise<Tenant | null> {
  if (!host) return null;

  const cacheKey = new Request(`https://cache/${host}`);
  const cache = (caches as any).default;

  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  let tenant = await fetchClubBy(env, "primary_domain", host);

  if (!tenant) {
    const slug = extractSlugFromFallbackHost(host, env.FALLBACK_SUFFIX);
    if (slug) {
      tenant = await fetchClubBy(env, "slug", slug);
    }
  }

  const res = Response.json(tenant, {
    headers: { "cache-control": tenant ? "max-age=60" : "max-age=30" },
  });

  await cache.put(cacheKey, res.clone());

  return tenant;
}

function css(tenant: Tenant) {
  return `
:root {
  --primary: ${tenant.primary_color || "#0ea5e9"};
  --secondary: ${tenant.secondary_color || "#0369a1"};
}
`;
}

function manifest(tenant: Tenant) {
  return {
    name: tenant.name || tenant.slug,
    short_name: tenant.slug,
    start_url: "/",
    display: "standalone",
    theme_color: tenant.primary_color || "#0ea5e9",
    icons: tenant.manifest_icon_url
      ? [{ src: tenant.manifest_icon_url, sizes: "512x512", type: "image/png" }]
      : [],
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const host = normalizeHost(
      request.headers.get("x-forwarded-host") || request.headers.get("host")
    );

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    const tenant = await resolveTenant(host, env);

    if (!tenant) {
      return Response.json(
        { error: "CLUB_NOT_FOUND", host },
        { status: 404 }
      );
    }

    if (url.pathname === "/theme.css") {
      return new Response(css(tenant), {
        headers: {
          "content-type": "text/css",
          "cache-control": "max-age=60",
          vary: "Host",
        },
      });
    }

    if (url.pathname === "/manifest.webmanifest") {
      return new Response(JSON.stringify(manifest(tenant)), {
        headers: {
          "content-type": "application/json",
          "cache-control": "max-age=60",
          vary: "Host",
        },
      });
    }

    // ✅ PROXY FINAL (o que faltava)
    const origin = new URL(env.PAGES_ORIGIN);
    const proxyUrl = new URL(request.url);

    proxyUrl.protocol = origin.protocol;
    proxyUrl.hostname = origin.hostname;

    const proxied = await fetch(
      new Request(proxyUrl.toString(), request),
      { cf: { cacheTtl: 0 } } as any
    );

    const headers = new Headers(proxied.headers);
    headers.set("Vary", "Host");

    return new Response(proxied.body, {
      status: proxied.status,
      headers,
    });
  },
};

