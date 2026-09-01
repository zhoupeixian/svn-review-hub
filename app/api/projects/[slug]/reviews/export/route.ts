import { exportReviewsForProject } from '@/lib/project-review-export';
import { handleEnabledReviewProject } from '@/lib/project-api';

type Context = {
  params: Promise<{ slug: string }>;
};

export async function GET(request: Request, { params }: Context) {
  return handleEnabledReviewProject(params, (project) =>
    exportReviewsForProject(request, project));
}
