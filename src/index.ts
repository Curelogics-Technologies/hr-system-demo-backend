
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { createServer } from 'http';
import { queryOne } from './config/database';
import { resolveAllowedCompanyIds } from './utils/companyScope';
import { initSocket } from './config/socket';

// Phase 1 modules
import authRoutes from './modules/auth/auth.routes';
import { authenticate } from './middleware/auth';
import { seed, migrate } from './scripts/seed';
import { productionSeed } from './scripts/productionSeed';
import companiesRoutes from './modules/companies/companies.routes';
import companyGroupsRoutes from './modules/companyGroups/companyGroups.routes';
import storesRoutes from './modules/stores/stores.routes';
import employeesRoutes from './modules/employees/employees.routes';
import permissionsRoutes from './modules/permissions/permissions.routes';
import homeRoutes from './modules/home/home.routes';
import searchRoutes from './modules/search/search.routes';

// Phase 2 modules
import messagesRoutes from './modules/messages/messages.routes';
import shiftsRoutes from './modules/shifts/shifts.routes';
import externalAffluenceRoutes from './modules/externalAffluence/externalAffluence.routes';
import attendanceRoutes from './modules/attendance/attendance.routes';
import qrRoutes from './modules/attendance/qr.routes';
import leaveRoutes from './modules/leave/leave.routes';
// Phase 3 modules
import documentsRoutes from './modules/documents/documents.routes';
import notificationsRoutes from './modules/notifications/notifications.routes';
import atsRoutes from './modules/ats/ats.routes';
import onboardingRoutes from './modules/onboarding/onboarding.routes';
import windowDisplayRoutes from './modules/window-display/window-display.routes';
import publicCareersRoutes from './modules/publicCareers/publicCareers.routes';
import emailRoutes from './modules/email/email.routes';
import indeedIntegrationRoutes from './modules/integrations/indeed.routes';
import { getPublishedJobsForFeed } from './modules/ats/ats.service';
import { startScheduler } from './jobs/scheduler';
import transfersRoutes from './modules/transfers/transfers.routes';
import deviceRoutes from './modules/device/device.routes';
import terminalsRoutes from './modules/terminals/terminals.routes';
import automationsRoutes from './modules/automations/automations.routes';
import reportsRoutes from './modules/reports/reports.routes';
import { processEscalationLogic } from './modules/leave/leave.controller';
import locationRoutes from './modules/location/location.routes';
import { ssrRendererMiddleware } from './middleware/ssr-renderer.middleware';
import billingRoutes from './modules/billing/billing.routes';
import webhookRoutes from './modules/billing/webhook.routes';
import { billingGuard } from './middleware/billingGuard';
import { LicenseLimitError } from './modules/billing/license.service';
import { startBillingCron } from './jobs/billing.job';

dotenv.config();

const app = express();
app.set('trust proxy', true);
const PORT = Number(process.env.PORT) || 3001;
// const PORT = process.env.PORT || 3001;

const rawCorsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

let allowedOrigins: string[];
if (rawCorsOrigins.length > 0) {
  allowedOrigins = rawCorsOrigins;
} else if (process.env.NODE_ENV === 'production') {
  console.error('FATAL: CORS_ORIGIN must be set in production.');
  process.exit(1);
} else {
  allowedOrigins = ['http://localhost:5173'];
}

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, mobile apps, server-to-server)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    
    // In development, dynamically allow local network IP origins (e.g. http://192.168.x.x:5173)
    if (process.env.NODE_ENV !== 'production') {
      const isLocalIp = /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(origin);
      if (isLocalIp) return cb(null, true);
    }
    
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
}));
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use('/api/webhooks/paypal', express.raw({ type: 'application/json' }));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/public/indeed-apply/') || req.path === '/api/webhooks/stripe' || req.path === '/api/webhooks/paypal') {
    next();
  } else {
    express.json()(req, res, next);
  }
});
app.use(ssrRendererMiddleware);

// Serve uploaded files (avatars) behind authentication — prevents unauthenticated PII access
const uploadsRoot = process.env.UPLOADS_DIR
  ? path.dirname(process.env.UPLOADS_DIR)
  : path.join(process.cwd(), 'uploads');

// Promote ?token= query param to Authorization header so <img> tags can load avatars.
// The authenticate middleware only reads headers, so we bridge the gap here.
app.get('/uploads/avatars/:filename', (req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}, authenticate, async (req, res) => {
  const { filename } = req.params;
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    res.status(400).end();
    return;
  }
  // Verify the avatar belongs to a user in the requester's company
  const userId = parseInt(filename.split('.')[0], 10);
  if (!Number.isFinite(userId)) {
    res.status(404).end();
    return;
  }
  const owner = await queryOne<{ companyId: number }>(
    `SELECT company_id AS "companyId" FROM users WHERE id = $1`,
    [userId]
  );
  if (!owner) {
    res.status(404).end();
    return;
  }
  
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  
  // Allow access if:
  // 1. User belongs to same company, OR
  // 2. User is viewing a job post created by this user (for ATS module)
  const hasDirectAccess = allowedCompanyIds.includes(owner.companyId);
  
  let hasJobPostAccess = false;
  if (!hasDirectAccess) {
    // Check if this user created any job posts that the requester can view
    const jobPostCheck = await queryOne<{ count: number }>(
      `SELECT COUNT(*) as count 
       FROM job_postings j
       WHERE j.created_by_id = $1 
         AND j.company_id = ANY($2::int[])
         AND j.status IN ('published', 'closed')`,
      [userId, allowedCompanyIds]
    );
    hasJobPostAccess = (jobPostCheck?.count ?? 0) > 0;
  }
  
  if (!hasDirectAccess && !hasJobPostAccess) {
    res.status(403).end();
    return;
  }
  
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const contentType = mimeTypes[ext];
  if (contentType) res.setHeader('Content-Type', contentType);
  const filePath = path.join(uploadsRoot, 'avatars', filename);
  res.sendFile(filePath, (err) => { if (err) res.status(404).end(); });
});

app.get('/uploads/company-logos/:filename', (req, res) => {
  const { filename } = req.params;
  const match = /^company-(\d+)\.[a-zA-Z0-9]+$/.exec(filename);
  if (!match) {
    res.status(400).end();
    return;
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const contentType = mimeTypes[ext];
  if (contentType) res.setHeader('Content-Type', contentType);

  const filePath = path.join(uploadsRoot, 'company-logos', filename);
  res.sendFile(filePath, (err) => { if (err) res.status(404).end(); });
});

app.get('/uploads/company-banners/:filename', (req, res) => {
  const { filename } = req.params;
  const match = /^company-banner-(\d+)\.[a-zA-Z0-9]+$/.exec(filename);
  if (!match) {
    res.status(400).end();
    return;
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const contentType = mimeTypes[ext];
  if (contentType) res.setHeader('Content-Type', contentType);

  const filePath = path.join(uploadsRoot, 'company-banners', filename);
  res.sendFile(filePath, (err) => { if (err) res.status(404).end(); });
});

app.get('/uploads/message-attachments/:filename', (req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}, authenticate, async (req, res) => {
  const { filename } = req.params;
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    res.status(400).end();
    return;
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const contentType = mimeTypes[ext];
  if (contentType) res.setHeader('Content-Type', contentType);

  const filePath = path.join(uploadsRoot, 'message-attachments', filename);
  res.sendFile(filePath, (err) => { if (err) res.status(404).end(); });
});

app.get('/uploads/public-avatars/:filename', async (req, res) => {
  const { filename } = req.params;
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    res.status(400).end();
    return;
  }

  const userId = parseInt(filename.split('.')[0], 10);
  if (!Number.isFinite(userId)) {
    res.status(404).end();
    return;
  }

  const owner = await queryOne<{ id: number }>(
    `SELECT u.id
     FROM users u
     JOIN companies c ON c.id = u.company_id
     WHERE u.id = $1
       AND u.status = 'active'
       AND c.is_active = true
       AND u.role IN ('admin', 'hr', 'area_manager', 'store_manager')
       AND EXISTS (
         SELECT 1
         FROM job_postings j
         WHERE j.company_id = u.company_id
           AND j.status IN ('published', 'closed')
       )
     LIMIT 1`,
    [userId],
  );
  if (!owner) {
    res.status(403).end();
    return;
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const contentType = mimeTypes[ext];
  if (contentType) res.setHeader('Content-Type', contentType);

  const filePath = path.join(uploadsRoot, 'avatars', filename);
  res.sendFile(filePath, (err) => { if (err) res.status(404).end(); });
});

app.get('/uploads/public-store-logos/:filename', async (req, res) => {
  const { filename } = req.params;
  const match = /^store-(\d+)\.[a-zA-Z0-9]+$/.exec(filename);
  if (!match) {
    res.status(400).end();
    return;
  }

  const storeId = parseInt(match[1], 10);
  if (!Number.isFinite(storeId)) {
    res.status(404).end();
    return;
  }

  const store = await queryOne<{ id: number }>(
    `SELECT s.id
     FROM stores s
     JOIN companies c ON c.id = s.company_id
     WHERE s.id = $1
       AND c.is_active = true
       AND EXISTS (
         SELECT 1
         FROM job_postings j
         WHERE j.store_id = s.id
           AND j.status IN ('published', 'closed')
       )
     LIMIT 1`,
    [storeId],
  );
  if (!store) {
    res.status(403).end();
    return;
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const contentType = mimeTypes[ext];
  if (contentType) res.setHeader('Content-Type', contentType);

  const filePath = path.join(uploadsRoot, 'store-logos', filename);
  res.sendFile(filePath, (err) => { if (err) res.status(404).end(); });
});

app.get('/uploads/store-logos/:filename', (req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}, authenticate, async (req, res) => {
  const { filename } = req.params;
  const match = /^store-(\d+)\.[a-zA-Z0-9]+$/.exec(filename);
  if (!match) {
    res.status(400).end();
    return;
  }

  const storeId = parseInt(match[1], 10);
  if (!Number.isFinite(storeId)) {
    res.status(404).end();
    return;
  }

  const store = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM stores WHERE id = $1`,
    [storeId],
  );
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (!store || !allowedCompanyIds.includes(store.company_id)) {
    res.status(403).end();
    return;
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const contentType = mimeTypes[ext];
  if (contentType) res.setHeader('Content-Type', contentType);

  const filePath = path.join(uploadsRoot, 'store-logos', filename);
  res.sendFile(filePath, (err) => { if (err) res.status(404).end(); });
});

// Serve CV/resume files behind authentication
app.get('/cvs/:filename', (req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}, authenticate, async (req, res) => {
  const { filename } = req.params;
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    res.status(400).end();
    return;
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
  };
  const contentType = mimeTypes[ext];
  if (contentType) res.setHeader('Content-Type', contentType);

  const cvsDir = process.env.UPLOADS_DIR
    ? path.join(path.dirname(process.env.UPLOADS_DIR), 'cvs')
    : path.join(process.cwd(), 'uploads', 'cvs');
  const filePath = path.join(cvsDir, filename);
  res.sendFile(filePath, (err) => { if (err) res.status(404).end(); });
});

// Serve public CV files behind authentication
app.get('/uploads/public-cv/:filename', (req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}, authenticate, async (req, res) => {
  const { filename } = req.params;
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    res.status(400).end();
    return;
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
  };
  const contentType = mimeTypes[ext];
  if (contentType) res.setHeader('Content-Type', contentType);

  const publicCvDir = process.env.PUBLIC_CV_UPLOAD_DIR
    ?? path.join(process.cwd(), 'uploads', 'public-cv');
  const filePath = path.join(publicCvDir, filename);
  res.sendFile(filePath, (err) => { if (err) res.status(404).end(); });
});

// Keep old endpoint for backward compatibility
app.get('/public-cv/:filename', (req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}, authenticate, async (req, res) => {
  const { filename } = req.params;
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    res.status(400).end();
    return;
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
  };
  const contentType = mimeTypes[ext];
  if (contentType) res.setHeader('Content-Type', contentType);

  const publicCvDir = process.env.PUBLIC_CV_UPLOAD_DIR
    ?? path.join(process.cwd(), 'uploads', 'public-cv');
  const filePath = path.join(publicCvDir, filename);
  res.sendFile(filePath, (err) => { if (err) res.status(404).end(); });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Dynamic sitemap.xml
app.get('/sitemap.xml', async (req, res, next) => {
  try {
    const frontendBase = resolveFrontendBase(req);
    const { jobs } = await getPublishedJobsForFeed('all');

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    // Static pages
    const staticPages = [
      { path: '/careers', freq: 'daily', priority: '0.8' },
      { path: '/privacy', freq: 'monthly', priority: '0.5' },
      { path: '/terms', freq: 'monthly', priority: '0.5' },
      { path: '/cookie-policy', freq: 'monthly', priority: '0.5' }
    ];

    for (const page of staticPages) {
      xml += '  <url>\n';
      xml += `    <loc>${frontendBase}${page.path}</loc>\n`;
      xml += `    <changefreq>${page.freq}</changefreq>\n`;
      xml += `    <priority>${page.priority}</priority>\n`;
      xml += '  </url>\n';
    }

    // Dynamic job pages
    for (const job of jobs) {
      const jobCompanySlug = encodeURIComponent(job.companySlug);
      const lastmodDate = job.publishedAt || job.updatedAt;
      const lastmodStr = lastmodDate ? new Date(lastmodDate).toISOString() : new Date().toISOString();

      xml += '  <url>\n';
      xml += `    <loc>${frontendBase}/careers/${jobCompanySlug}/jobs/${job.id}</loc>\n`;
      xml += `    <lastmod>${lastmodStr}</lastmod>\n`;
      xml += '    <changefreq>weekly</changefreq>\n';
      xml += '    <priority>0.9</priority>\n';
      xml += '  </url>\n';
    }

    xml += '</urlset>\n';

    res.header('Content-Type', 'application/xml');
    res.status(200).send(xml);
  } catch (err) {
    next(err);
  }
});

function resolveFrontendBase(req: express.Request): string {
  const raw = process.env.APP_BASE_URL ?? process.env.FRONTEND_URL ?? process.env.PUBLIC_APP_URL ?? process.env.CORS_ORIGIN?.split(',')[0];
  if (raw && raw.trim() !== '') {
    return raw.replace(/\/+$/, '');
  }

  const host = req.get('host');
  if (host) {
    return `${req.protocol}://${host}`.replace(/\/+$/, '');
  }

  return 'http://localhost:5173';
}

// Billing — Webhook routes (no auth, uses signature verification) + Billing routes
app.use('/api/webhooks', webhookRoutes);
app.use('/api/billing', authenticate, billingRoutes);

// Billing access guard — MUST be before all other route handlers
// Checks subscription status and blocks unpaid companies (except exempt paths/roles)
app.use('/api', billingGuard);

// Phase 1 API Routes
app.use('/api/auth', authRoutes);
app.use('/api/companies', companiesRoutes);
app.use('/api/company-groups', companyGroupsRoutes);
app.use('/api/stores', storesRoutes);
app.use('/api/employees', employeesRoutes);
app.use('/api/permissions', permissionsRoutes);
app.use('/api/home', homeRoutes);
app.use('/api/search', searchRoutes);

// Phase 2 API Routes
app.use('/api/shifts', shiftsRoutes);
app.use('/api/external-affluence', externalAffluenceRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/qr', qrRoutes);
app.use('/api/leave', leaveRoutes);
app.use('/api/transfers', transfersRoutes);
app.use('/api/device', deviceRoutes);
app.use('/api/terminals', terminalsRoutes);

// Communication board
app.use('/api/messages', messagesRoutes);

// Phase 3 APIs
app.use('/api/documents', documentsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/public', publicCareersRoutes);
app.use('/api/ats', atsRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/integrations/indeed', indeedIntegrationRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/window-display', windowDisplayRoutes);
app.use('/api/automations', automationsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/location', locationRoutes);

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Running out of paid licenses is an expected outcome, not a crash: answer
  // with 402 and the exact numbers so the UI can offer to buy more.
  if (err instanceof LicenseLimitError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code,
      ...err.details,
    });
    return;
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Errore interno del server', code: 'SERVER_ERROR' });
});

async function waitForDb(retries = 10, delayMs = 3000): Promise<void> {
  const { pool } = await import('./config/database');
  for (let i = 1; i <= retries; i++) {
    try {
      const client = await pool.connect();
      client.release();
      return;
    } catch (err: any) {
      if (i === retries) throw err;
      console.log(`DB not ready (attempt ${i}/${retries}), retrying in ${delayMs / 1000}s...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function start() {
  if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL environment variable is not set.');
    process.exit(1);
  }

  // Wait for PostgreSQL to be reachable (handles Railway startup race condition)
  await waitForDb();

  // Always apply migrations so the schema exists on fresh databases.
  // This is idempotent (CREATE TABLE IF NOT EXISTS) and safe every boot.
  await migrate();

  // Seed demo data only when explicitly requested.
  if (process.env.FORCE_SEED === 'true') {
    console.log('FORCE_SEED=true — seeding database...');
    await seed();
  }

  if (process.env.PRODUCTION_SEED === 'true') {
    await productionSeed();
  }

  const httpServer = createServer(app);
  initSocket(httpServer, allowedOrigins);

  // httpServer.listen(PORT, () => {
  //   console.log(`HR System backend running on http://localhost:${PORT}`);
  // });
  // Fixed (listens on all network interfaces)

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`HR System backend running on http://0.0.0.0:${PORT}`);
  });


  // Start background cron jobs (skip in test environment)
  if (process.env.NODE_ENV !== 'test') {
    startScheduler();
    startBillingCron();

    // Background auto-escalation task (runs every hour)
    setInterval(() => {
      console.log('Running background auto-escalation task...');
      processEscalationLogic()
        .then((count) => {
          if (count > 0) {
            console.log(`Auto-escalated ${count} leave requests.`);
          }
        })
        .catch((err) => {
          console.error('Error running auto-escalation:', err);
        });
    }, 1000 * 60 * 60);
  }
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});

export default app;
