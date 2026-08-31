import { getEnabledReviewProject, getReviewMarkdown } from '@/lib/reviews';

type Context = {
  params: Promise<{ slug: string; id: string }>;
};

export async function GET(_request: Request, { params }: Context) {
  const { slug, id } = await params;
  const project = await getEnabledReviewProject(slug);
  const review = project ? await getReviewMarkdown(project.id, Number(id)) : null;
  if (!review) return Response.json({ error: '审查日志不存在。' }, { status: 404 });

  return new Response(review.content, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(review.sourceName)}`,
    },
  });
}
