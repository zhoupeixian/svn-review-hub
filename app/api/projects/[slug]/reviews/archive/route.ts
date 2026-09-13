import { archiveReviewsForProject } from '@/lib/project-review-archive';
import { handleAccessibleReviewProject } from '@/lib/project-api';

type Context = {
  params: Promise<{ slug: string }>;
};

export async function POST(request: Request, { params }: Context) {
  return handleAccessibleReviewProject(params, (project) =>
    archiveReviewsForProject(request, project));
}
