import { authConfig, clearLoginAttempts, consumeLoginAttempt, createSession, localAuthEnabled, passwordMatches, safeLoginReturn, sessionCookie } from '@/lib/local-auth';

export async function POST(request: Request) {
  if (!localAuthEnabled()) return new Response(null, { status: 404 });
  const { origin } = authConfig();
  if (request.headers.get('origin') !== origin) return new Response(null, { status: 403 });
  if (!await consumeLoginAttempt(request)) return new Response('尝试过多，请在 15 分钟后重试。', { status: 429 });
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) { await reader.cancel(); return new Response(null, { status: 413 }); }
    chunks.push(value);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  if (!await passwordMatches(form.get('password') ?? '')) {
    return Response.redirect(`${origin}/login?error=invalid`, 303);
  }
  await clearLoginAttempts(request);
  return new Response(null, { status: 303, headers: {
    Location: new URL(safeLoginReturn(form.get('return_to')), origin).href,
    'Set-Cookie': sessionCookie(await createSession()),
    'Cache-Control': 'no-store',
  } });
}
