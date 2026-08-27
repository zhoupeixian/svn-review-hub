import { getReviewMarkdown } from '@/lib/reviews';

type Props = {
  params: Promise<{ id: string }>;
};

export async function GET(_: Request, { params }: Props) {
  const { id } = await params;
  const review = await getReviewMarkdown(Number(id));
  if (!review) {
    return new Response('未找到审查日志。', { status: 404 });
  }

  return new Response(review.content, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition':
        "attachment; filename*=UTF-8''" + encodeURIComponent(review.sourceName),
    },
  });
}
