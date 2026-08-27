// Force both database pools to use hr_system_test.
// Must run before any modules load so dotenv.config() in database.ts
// finds DATABASE_URL already set and does not override it.
//
// .env.test is read first so a developer's local credentials win over the
// placeholder below; the old hardcoded 'user' role does not exist on a stock
// Postgres install, which made every suite fail to start.
import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });

const TEST_DB = 'postgresql://postgres:postgres@localhost:5432/hr_system_test';
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || TEST_DB;
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.QR_SECRET = process.env.QR_SECRET || 'test-qr-secret';
// Use a writable temp directory for avatar uploads during tests
import os from 'os';
import path from 'path';
process.env.UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(os.tmpdir(), 'hr-test-uploads', 'avatars');
