export default function VolunteerPortalPage({
  params,
}: {
  params: { token: string };
}) {
  return (
    <div style={{ padding: 40 }}>
      <h1>Volunteer Portal</h1>
      <p>Token: {params.token}</p>
      <p>Coming soon.</p>
    </div>
  );
}