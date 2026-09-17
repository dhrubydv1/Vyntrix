const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error.message);
});

async function testConnection() {
  const result = await pool.query(
    'SELECT current_database(), current_user, NOW()'
  );

  return result.rows[0];
}

module.exports = {
  pool,
  testConnection
};
