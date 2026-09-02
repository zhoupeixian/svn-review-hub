import { restoreReviewsForProject } from '@/app/api/reviews/restore/route';
import { handleEnabledReviewProject } from '@/lib/project-api';

type Context = {
  params: Promise<{ slug: string }>;
};

export async function POST(request: Request, { params }: Context) {
  return handleEnabledReviewProject(params, (project) =>
    restoreReviewsForProject(request, project));
}
