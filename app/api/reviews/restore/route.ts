import { handleEnabledReviewProject } from '@/lib/project-api';
import { restoreReviewsForProject } from '@/lib/project-review-restore';

export async function POST(request: Request) {
  return handleEnabledReviewProject('zherp', (project) =>
    restoreReviewsForProject(request, project));
}
