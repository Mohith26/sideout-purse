import { redirect } from 'next/navigation';

/** Phase 7's entry page folded into registration's second step (spec 5.3, "Register"). */
export default async function EnterPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(`/t/${slug}/register`);
}
