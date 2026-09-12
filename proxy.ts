import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  if (process.env.PORTAL_RUNTIME !== 'node') return NextResponse.next();
  const headers = new Headers(request.headers);
  headers.delete('cf-connecting-ip');
  if (process.env.PORTAL_TRUST_PROXY === 'true') {
    const address = request.headers.get('x-real-ip');
    if (address) headers.set('cf-connecting-ip', address);
  }
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ['/api/:path*'] };
