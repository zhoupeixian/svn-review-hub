import { exportReviewsForProject } from '@/lib/project-review-export';
import { handleEnabledReviewProject } from '@/lib/project-api';

export async function GET(request: Request) {
  return handleEnabledReviewProject('zherp', (project) =>
    exportReviewsForProject(request, project));
}
