import { handleEnabledReviewProject } from '@/lib/project-api';
import { archiveReviewsForProject } from '@/lib/project-review-archive';

export async function POST(request: Request) {
  return handleEnabledReviewProject('zherp', (project) =>
    archiveReviewsForProject(request, project));
}
