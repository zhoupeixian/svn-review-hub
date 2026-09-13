import { expect, it } from 'vitest';
import { createNodeStorage } from '../lib/node-storage';

it('对象列表与 head 只返回元数据，分页与原文读取保持一致', async () => {
  const storage = createNodeStorage(':memory:');
  try {
    await storage.FILES.put('project/a.md', '中文原文', { httpMetadata: { contentType: 'text/markdown' } });
    await storage.FILES.put('project/b.md', 'second');
    const page = await storage.FILES.list({ prefix: 'project/', limit: 1 });
    expect(page.objects).toHaveLength(1);
    expect(page.objects[0]).toMatchObject({ key: 'project/a.md', size: 12, httpMetadata: { contentType: 'text/markdown' } });
    expect(page.objects[0]).not.toHaveProperty('body');
    expect(page.objects[0]).not.toHaveProperty('text');
    expect(await storage.FILES.head('project/a.md')).toEqual(page.objects[0]);
    expect(await storage.FILES.head('missing')).toBeNull();
    const next = await storage.FILES.list({ prefix: 'project/', cursor: page.truncated ? page.cursor : undefined });
    expect(next.objects.map((item) => item.key)).toEqual(['project/b.md']);
    expect(next.truncated).toBe(false);
    const object = await storage.FILES.get('project/a.md');
    expect(await object?.text()).toBe('中文原文');
    expect(object?.etag).toBe(page.objects[0].etag);
  } finally { storage.close(); }
});
