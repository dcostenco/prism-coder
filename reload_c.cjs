const sqlite3 = require('better-sqlite3');
const pg = require('pg');

async function main() {
  const db = new sqlite3(process.env.HOME + '/.prism-mcp/prism-config.db');
  
  const urlRow = db.prepare("SELECT value FROM settings WHERE key='SUPABASE_URL'").get();
  const keyRow = db.prepare("SELECT value FROM settings WHERE key='SUPABASE_SERVICE_ROLE_KEY'").get() || db.prepare("SELECT value FROM settings WHERE key='SUPABASE_KEY'").get();
  
  if (!urlRow || !keyRow) {
      console.error("Missing config!");
      return;
  }
  
  const url = urlRow.value;
  let password = keyRow.value;
  // some passwords have / etc, but we'll try raw or encoded
  password = encodeURIComponent(password);
  
  const host = new URL(url).host.split('.')[0];
  const dbHost = `db.${host}.supabase.co`;
  const cx = `postgresql://postgres:${password}@${dbHost}:5432/postgres`;
  
  const client = new pg.Client({ connectionString: cx });
  await client.connect();
  await client.query("NOTIFY pgrst, 'reload schema';");
  console.log('Schema reloaded via config!');
  await client.end();
}
main().catch(console.error);
