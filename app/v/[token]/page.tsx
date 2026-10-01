import TourPortalClient from "./TourPortalClient";

export default async function VolunteerPortalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <TourPortalClient token={token} />;
}
