import { authConfig, localAuthEnabled, sessionCookie } from '@/lib/local-auth';

export async function POST(request: Request) {
  if (!localAuthEnabled()) return new Response(null, { status: 404 });
  const { origin } = authConfig();
  if (request.headers.get('origin') !== origin) return new Response(null, { status: 403 });
  return new Response(null, { status: 303, headers: {
    Location: `${origin}/`, 'Set-Cookie': sessionCookie('', true), 'Cache-Control': 'no-store',
  } });
}
