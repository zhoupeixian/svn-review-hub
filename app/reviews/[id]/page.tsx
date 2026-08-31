import { redirect } from 'next/navigation';

type Props = {
  params: Promise<{ id: string }>;
};

export default async function LegacyReviewPage({ params }: Props) {
  const { id } = await params;
  redirect(`/projects/zherp/reviews/${encodeURIComponent(id)}`);
}
