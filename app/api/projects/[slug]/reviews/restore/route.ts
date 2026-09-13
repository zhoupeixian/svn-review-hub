import { restoreReviewsForProject } from '@/lib/project-review-restore';
import { handleAccessibleReviewProject } from '@/lib/project-api';

type Context = {
  params: Promise<{ slug: string }>;
};

export async function POST(request: Request, { params }: Context) {
  return handleAccessibleReviewProject(params, (project) =>
    restoreReviewsForProject(request, project));
}
