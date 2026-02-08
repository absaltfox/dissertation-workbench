import { ensureStorage, getDb, deleteUser, createUser } from '../src/db.js';
import { createPasswordHash } from '../src/auth.js';
import crypto from 'node:crypto';

await ensureStorage();
getDb();

const password = crypto.randomBytes(16).toString('hex');
const { hash, salt } = createPasswordHash(password);

try { deleteUser('admin'); } catch { /* may not exist */ }
createUser('admin', hash, salt);

console.log('');
console.log('Admin password reset.');
console.log(`  Username: admin`);
console.log(`  Password: ${password}`);
console.log('');

process.exit(0);
