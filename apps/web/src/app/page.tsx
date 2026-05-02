export default function HomePage() {
  return (
    <main style= padding: 24, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" >
      <h1>BoraSport</h1>
      <p>Deploy OK.</p>

      <h2>Próximos passos</h2>
      <ol>
        <li>Publicar o Worker (edge) e ligar o NEXT_PUBLIC_EDGE_BASE_URL.</li>
        <li>RLS (policies) no Supabase.</li>
        <li>Auth + memberships.</li>
        <li>Slots e bookings.</li>
      </ol>
    </main>
  );
}
