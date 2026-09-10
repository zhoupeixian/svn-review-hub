/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { getReviewProjectDirectory } from '@/lib/reviews';

type TestEnv = {
  DB: D1Database;
  REVIEW_SYNC_KEY?: string;
  REVIEW_SYNC_MASTER_KEY?: string;
};

it('冷启动缺少同步主密钥时不阻塞普通读取', async () => {
  const runtime = env as unknown as TestEnv;
  const originalLegacyKey = runtime.REVIEW_SYNC_KEY;
  const originalMasterKey = runtime.REVIEW_SYNC_MASTER_KEY;
  try {
    runtime.REVIEW_SYNC_KEY = 'legacy-zherp-secret';
    runtime.REVIEW_SYNC_MASTER_KEY = undefined;

    await expect(getReviewProjectDirectory()).resolves.toEqual([
      expect.objectContaining({ id: 1, slug: 'zherp' }),
    ]);
    expect(await runtime.DB.prepare(
      'SELECT sync_key_encrypted AS encrypted FROM review_projects WHERE id = 1',
    ).first()).toEqual({ encrypted: null });
  } finally {
    runtime.REVIEW_SYNC_KEY = originalLegacyKey;
    runtime.REVIEW_SYNC_MASTER_KEY = originalMasterKey;
  }
});
