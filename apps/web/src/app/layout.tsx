export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <link
          rel="stylesheet"
          href={`${process.env.NEXT_PUBLIC_EDGE_BASE_URL}/theme.css`}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
