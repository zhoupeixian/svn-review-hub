import { env } from '@/lib/runtime';
import { ensureReviewSchema } from '@/lib/reviews';

export async function GET() {
  try {
    await ensureReviewSchema();
    await (env as unknown as { DB: D1Database }).DB.prepare('SELECT 1').first();
    return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
