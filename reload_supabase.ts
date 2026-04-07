import { getAllSettings } from './src/storage/configStorage.js';
import pg from 'pg';

async function main() {
  const settings = await getAllSettings();
  const url = settings.SUPABASE_URL;
  let password = settings.SUPABASE_SERVICE_ROLE_KEY || settings.SUPABASE_KEY;
  
  if (!url || !password) {
      console.log("No Supabase Config");
      return;
  }
  
  password = encodeURIComponent(password);
  const host = new URL(url).host.split('.')[0];
  const dbHost = `db.${host}.supabase.co`;
  const cx = `postgresql://postgres:${password}@${dbHost}:5432/postgres`;
  
  const client = new pg.Client({ connectionString: cx });
  await client.connect();
  await client.query("NOTIFY pgrst, 'reload schema';");
  console.log('Schema reloaded successfully!');
  await client.end();
}
main().catch(console.error);
