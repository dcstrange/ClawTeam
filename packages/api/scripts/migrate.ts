/**
 * Simple Migration Runner
 *
 * Usage:
 *   npx tsx packages/api/scripts/migrate.ts up
 *   npx tsx packages/api/scripts/migrate.ts down
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');
loadEnv({ path: path.resolve(__dirname, '../../../.env') });

async function getClient(): Promise<Client> {
  const defaultPassword = process.env.POSTGRES_PASSWORD || 'changeme';
  const connectionString = process.env.DATABASE_URL || `postgresql://clawteam:${defaultPassword}@localhost:5432/clawteam`;
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

function parseMigration(content: string): { up: string; down: string } {
  const upMarker = '-- Up';
  const downMarker = '-- Down';

  const upIndex = content.indexOf(upMarker);
  const downIndex = content.indexOf(downMarker);

  if (upIndex === -1 || downIndex === -1) {
    throw new Error('Migration file must contain "-- Up" and "-- Down" markers');
  }

  const up = content.substring(upIndex + upMarker.length, downIndex).trim();
  const down = content.substring(downIndex + downMarker.length).trim();

  return { up, down };
}

function getMigrationFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function getAppliedMigrations(client: Client): Promise<Set<string>> {
  const result = await client.query('SELECT name FROM _migrations ORDER BY id');
  return new Set(result.rows.map((r: { name: string }) => r.name));
}

async function up(): Promise<void> {
  const client = await getClient();

  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);
    const files = getMigrationFiles();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  skip: ${file} (already applied)`);
        continue;
      }

      const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      const migration = parseMigration(content);

      console.log(`  applying: ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(migration.up);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  applied: ${file}`);
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log(`\nMigrations complete. ${count} applied.`);
  } finally {
    await client.end();
  }
}

async function down(): Promise<void> {
  const client = await getClient();

  try {
    await ensureMigrationsTable(client);
    const result = await client.query('SELECT name FROM _migrations ORDER BY id DESC LIMIT 1');

    if (result.rows.length === 0) {
      console.log('No migrations to rollback.');
      return;
    }

    const lastMigration = result.rows[0].name;
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, lastMigration), 'utf-8');
    const migration = parseMigration(content);

    console.log(`  rolling back: ${lastMigration}`);
    await client.query('BEGIN');
    try {
      await client.query(migration.down);
      await client.query('DELETE FROM _migrations WHERE name = $1', [lastMigration]);
      await client.query('COMMIT');
      console.log(`  rolled back: ${lastMigration}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === 'up') {
    console.log('Running migrations up...\n');
    await up();
  } else if (command === 'down') {
    console.log('Running migration down...\n');
    await down();
  } else {
    console.error('Usage: migrate.ts <up|down>');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
