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

  // Evita casos tipo ".borasport.app" (slug vazio) e também host == suffix
  if (!slug) return null;

  // Segurança mínima: impedir caracteres estranhos no slug
  // (ajuste conforme seu padrão real de slug)
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

/**
 * Consulta o Supabase via REST (PostgREST).
 * Requer que a tabela/classe "clubs" esteja exposta no schema "public" (padrão do Supabase).
 * Usamos "Accept: application/vnd.pgrst.object+json" para retornar um objeto único.
 */
async function fetchClubBy(
  env: Env,
  field: "primary_domain" | "slug",
  value: string,
): Promise<Tenant | null> {
  const url = new URL(buildSupabaseRestUrl(env, "/rest/v1/clubs"));

  // Seleção mínima de colunas (adicione mais campos se você quiser theme/manifest dinâmicos)
  url.searchParams.set("select", "id,slug,primary_domain");
  url.searchParams.set(field, `eq.${value}`);
  url.searchParams.set("limit", "1");

  const resp = await fetch(url.toString(), {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      Accept: "application/vnd.pgrst.object+json",
    },
    // GET por padrão
  });

  // 406 ou 404 podem aparecer dependendo de como o PostgREST responde quando não encontra
  if (resp.status === 404) return null;

  if (resp.status === 406) {
    // No rows (com Accept object) geralmente resulta em 406
    return null;
  }

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

  // Normalização para o shape de tenant que o worker usa
  return {
    club_id: data.id,
    slug: data.slug,
    primary_domain: data.primary_domain,
  };
}

/**
 * Resolve tenant (club) baseado no host.
 * Regra:
 * 1) host existe em clubs.primary_domain → retorna aquele club
 * 2) senão, se host termina com FALLBACK_SUFFIX (ex: .borasport.app) → slug e query clubs.slug
 * 3) senão → null
 *
 * Cache:
 * - cacheia por host por 60s (ajuste conforme necessidade)
 * - não cacheia erros (para não “envenenar”)
 */
async function resolveTenantByHost(host: string, env: Env): Promise<Tenant | null> {
  if (!host) return null;

  const cacheKey = new Request(
  `https://tenant-resolver.local/resolve?host=${encodeURIComponent(host)}`
);
const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = (await cached.json()) as Tenant | null;
    return data;
  }

  // 1) Domínio próprio
  // (host já normalizado — sem www, sem porta)
  try {
    const byDomain = await fetchClubBy(env, "primary_domain", host);
    if (byDomain) {
      const res = Response.json(byDomain, {
        headers: {
          "cache-control": "public, max-age=60",
        },
      });
      await cache.put(cacheKey, res.clone());
      return byDomain;
    }
  } catch (err) {
    // Se Supabase estiver off, não “derruba” tudo aqui — deixa o fetch lidar adiante se quiser.
    // Mas aqui preferimos falhar de forma clara (já que tenant é essencial).
    throw err;
  }

  // 2) Fallback por slug em {slug}.borasport.app
  const slug = extractSlugFromFallbackHost(host, env.FALLBACK_SUFFIX);
  if (slug) {
    const bySlug = await fetchClubBy(env, "slug", slug);
    if (bySlug) {
      const res = Response.json(bySlug, {
        headers: {
          "cache-control": "public, max-age=60",
        },
      });
      await cache.put(cacheKey, res.clone());
      return bySlug;
    }
  }

  // Cache de "não encontrado" (curto) para evitar martelar Supabase em host inválido
  const res = Response.json(null, {
    headers: {
      "cache-control": "public, max-age=30",
    },
  });
  await cache.put(cacheKey, res.clone());

  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      assertEnv(env);

      const url = new URL(request.url);
      const host = normalizeHost(
        request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
      );

      // Rotas de infra básicas
      if (url.pathname === "/health") return new Response("ok");

      const tenant = await resolveTenantByHost(host, env);

      if (!tenant) {
        return Response.json({ error: "CLUB_NOT_FOUND", host }, { status: 404 });
      }

      // Assets por tenant (MVP)
      if (url.pathname === "/theme.css") {
        // Aqui você pode evoluir depois para puxar cores/logo do Supabase
        const css = `:root{--club-slug:${tenant.slug};--primary:#0ea5e9;}`;
        return new Response(css, {
          headers: {
            "content-type": "text/css; charset=utf-8",
            // Importante: varia por host
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
            // Importante: varia por host
            "cache-control": "public, max-age=60",
          },
        });
      }

      // Por enquanto: retorna tenant resolvido (pra você testar host routing)
      return Response.json({ ok: true, host, tenant });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      // Não expor envs/keys aqui
      return Response.json(
        { error: "EDGE_INTERNAL_ERROR", message },
        { status: 500 },
      );
    }
  },
};
