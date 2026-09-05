import { archiveReviewsForProject } from '@/app/api/reviews/archive/route';
import { handleAccessibleReviewProject } from '@/lib/project-api';

type Context = {
  params: Promise<{ slug: string }>;
};

export async function POST(request: Request, { params }: Context) {
  return handleAccessibleReviewProject(params, (project) =>
    archiveReviewsForProject(request, project));
}
