type RawSearchParams = Record<string, string | string[] | undefined>;

export function legacyProjectPath(
  section: string,
  searchParams: RawSearchParams = {},
): string {
  const query = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(searchParams)) {
    for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      if (typeof value === 'string') query.append(key, value);
    }
  }
  const path = `/projects/zherp${section.startsWith('/') ? section : `/${section}`}`;
  return query.size ? `${path}?${query}` : path;
}
