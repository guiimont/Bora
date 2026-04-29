type Env = {
  BASE_DOMAIN: string;
  FALLBACK_SUFFIX: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
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
  return slug || null;
}

// Placeholder: por enquanto só resolve por slug (fallback).
// Próximo passo: buscar no Supabase (clubs.slug / clubs.primary_domain)
async function resolveTenantByHost(host: string, env: Env) {
  // FUTURO (domínio próprio):
  // 1) query clubs.primary_domain == host

  // PROTÓTIPO (slug.borasport.app):
  const slug = extractSlugFromFallbackHost(host, env.FALLBACK_SUFFIX);
  if (slug) return { club_id: `slug:${slug}`, slug };

  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const host = normalizeHost(request.headers.get("x-forwarded-host") ?? request.headers.get("host"));

    const tenant = await resolveTenantByHost(host, env);

    // Rotas de infra básicas
    if (url.pathname === "/health") return new Response("ok");

    if (!tenant) return Response.json({ error: "CLUB_NOT_FOUND", host }, { status: 404 });

    // Assets por tenant (MVP)
    if (url.pathname === "/theme.css") {
      const css = `:root{--club-slug:${tenant.slug};--primary:#0ea5e9;}`;
      return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
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
        headers: { "content-type": "application/manifest+json; charset=utf-8" },
      });
    }

    // Por enquanto: retorna tenant resolvido (pra você testar host routing)
    return Response.json({ ok: true, host, tenant });
  },
};
