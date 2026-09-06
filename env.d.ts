declare namespace Cloudflare {
  interface Env {
    FILES: R2Bucket;
    ANONYMOUS_SOURCE_HASH_KEY: string;
    REVIEW_SYNC_MASTER_KEY: string;
  }
}
