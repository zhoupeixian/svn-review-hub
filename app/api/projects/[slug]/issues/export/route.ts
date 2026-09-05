import { exportIssuesForProject } from '@/lib/project-review-export';
import { handleAccessibleReviewProject } from '@/lib/project-api';

type Context = {
  params: Promise<{ slug: string }>;
};

export async function GET(request: Request, { params }: Context) {
  return handleAccessibleReviewProject(params, (project) =>
    exportIssuesForProject(request, project));
}
