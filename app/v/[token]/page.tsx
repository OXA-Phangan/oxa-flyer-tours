export default async function VolunteerPortalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <div style={{ padding: 40 }}>
      <h1>Volunteer Portal</h1>
      <p>Token: {token}</p>
      <p>Coming soon.</p>
    </div>
  );
}
