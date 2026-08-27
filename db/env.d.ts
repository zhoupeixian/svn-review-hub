declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    FILES: R2Bucket;
    REVIEW_SYNC_KEY?: string;
  }
}
