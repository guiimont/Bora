export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Em runtime no browser, vamos usar window.location.host.
  // Mas como layout.tsx roda no servidor também, precisamos de um fallback seguro.
  // Para o MVP, carregamos o CSS no client (script pequeno) para garantir host correto.

  return (
    <html lang="pt-BR">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                var edge = ${JSON.stringify(process.env.NEXT_PUBLIC_EDGE_BASE_URL || "")};
                if (!edge) return;

                var host = window.location.host;
                var cssHref = edge.replace(/\\/$/, "") + "/theme.css?host=" + encodeURIComponent(host);

                var link = document.createElement("link");
                link.rel = "stylesheet";
                link.href = cssHref;
                document.head.appendChild(link);

                var manifestHref = edge.replace(/\\/$/, "") + "/manifest.webmanifest?host=" + encodeURIComponent(host);
                var manifest = document.createElement("link");
                manifest.rel = "manifest";
                manifest.href = manifestHref;
                document.head.appendChild(manifest);
              })();
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
