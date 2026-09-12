export async function applyD1Migrations(db: D1Database, migrations: Array<{ queries: string[] }>) {
  for (const migration of migrations) {
    await db.batch(migration.queries.map((query) => db.prepare(query)));
  }
}
