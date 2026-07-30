import { NextFunction, Request, Response } from 'express';
import { 
  listPublicJobs, 
  getPublicJobById, 
  getPublicCompanyBySlug,
  getPublicCompanyById,
  mapPublicJob
} from '../modules/publicCareers/publicCareers.routes';
import { salaryPeriodItalianLabel } from '../utils/salaryPeriod';
import { queryOne } from '../config/database';

// In-memory cache for rendered HTML pages
interface CacheEntry {
  html: string;
  expiry: number;
}

const renderCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 3600 * 1000; // 1 hour

// Helper to resolve frontend base URL
function resolveFrontendBase(req: Request): string {
  const raw = process.env.FRONTEND_URL ?? process.env.PUBLIC_APP_URL ?? process.env.CORS_ORIGIN?.split(',')[0];
  if (raw && raw.trim() !== '') {
    return raw.replace(/\/+$/, '');
  }

  const host = req.get('host');
  if (host) {
    // If running inside docker/behind nginx, host might be backend:3001, but req.protocol and request headers might help
    const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
    const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol;
    if (forwardedHost) {
      return `${forwardedProto}://${forwardedHost}`.replace(/\/+$/, '');
    }
    return `${req.protocol}://${host}`.replace(/\/+$/, '');
  }

  return 'http://localhost:5173';
}

// Helper to escape HTML characters
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Generate premium, responsive HTML template wrapper
/**
 * Platform identity for pages that are not scoped to a single company.
 *
 * These pages must never fall back to a tenant's name: this is a multi-company
 * platform, and showing one client's identity on a shared page misattributes it.
 * The platform name is read from legal_documents (set by a super admin in the
 * Legal Documents screen); when it is absent we render nothing rather than
 * inventing a default.
 */
const PLATFORM_FALLBACK_NAME = 'Veylo HR';

function wrapPageTemplate(title: string, content: string, brandName = ''): string {
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #c9973a;
      --primary-hover: #b0822e;
      --dark: #0f172a;
      --gray-light: #f8fafc;
      --gray-border: #e2e8f0;
      --text: #334155;
      --text-dark: #0f172a;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: 'Outfit', sans-serif;
      line-height: 1.6;
      color: var(--text);
      background-color: var(--gray-light);
      padding: 0;
      margin: 0;
    }
    header {
      background-color: var(--dark);
      color: white;
      padding: 24px 5%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 3px solid var(--primary);
    }
    header h1 {
      font-size: 24px;
      font-weight: 800;
      color: white;
      letter-spacing: -0.5px;
    }
    header h1 span {
      color: var(--primary);
    }
    .container {
      max-width: 1000px;
      margin: 40px auto;
      padding: 0 20px;
    }
    .card {
      background: white;
      border: 1px solid var(--gray-border);
      border-radius: 12px;
      padding: 32px;
      box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05), 0 2px 4px -2px rgb(0 0 0 / 0.05);
    }
    h2 {
      font-size: 28px;
      font-weight: 700;
      color: var(--text-dark);
      margin-bottom: 16px;
    }
    .meta-group {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 24px;
    }
    .badge {
      background-color: #f1f5f9;
      color: #475569;
      padding: 6px 12px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 600;
    }
    .badge.primary {
      background-color: rgba(201, 151, 58, 0.1);
      color: var(--primary-hover);
    }
    .divider {
      height: 1px;
      background-color: var(--gray-border);
      margin: 24px 0;
    }
    .rich-text {
      color: var(--text);
      font-size: 16px;
    }
    .rich-text h1, .rich-text h2, .rich-text h3 {
      color: var(--text-dark);
      margin-top: 20px;
      margin-bottom: 10px;
    }
    .rich-text p {
      margin-bottom: 16px;
    }
    .rich-text ul, .rich-text ol {
      margin-left: 24px;
      margin-bottom: 16px;
    }
    .rich-text li {
      margin-bottom: 6px;
    }
    .btn-apply {
      display: inline-block;
      background-color: var(--primary);
      color: white;
      text-decoration: none;
      padding: 12px 28px;
      border-radius: 8px;
      font-weight: 700;
      font-size: 16px;
      transition: background-color 0.2s;
      margin-top: 20px;
    }
    .btn-apply:hover {
      background-color: var(--primary-hover);
    }
    .job-list {
      display: grid;
      gap: 20px;
    }
    .job-card {
      background: white;
      border: 1px solid var(--gray-border);
      border-radius: 12px;
      padding: 24px;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .job-card h3 {
      font-size: 20px;
      font-weight: 700;
      color: var(--text-dark);
      margin-bottom: 8px;
    }
    .job-card p {
      color: var(--text);
      font-size: 15px;
      margin-bottom: 16px;
    }
    .job-card-link {
      color: var(--primary);
      text-decoration: none;
      font-weight: 700;
      font-size: 14px;
      display: inline-flex;
      align-items: center;
    }
    .job-card-link:hover {
      color: var(--primary-hover);
      text-decoration: underline;
    }
    footer {
      text-align: center;
      padding: 40px 20px;
      color: #64748b;
      font-size: 14px;
      border-top: 1px solid var(--gray-border);
      margin-top: 60px;
      background: white;
    }
    footer a {
      color: #64748b;
      text-decoration: underline;
      margin: 0 10px;
    }
    footer a:hover {
      color: var(--primary);
    }
  </style>
</head>
<body>
  <header>
    <h1>${brandName ? `${escapeHtml(brandName)} <span>Careers</span>` : '<span>Careers</span>'}</h1>
  </header>
  <main class="container">
    ${content}
  </main>
  <footer>
    <p>&copy; ${new Date().getFullYear()}${brandName ? ` ${escapeHtml(brandName)}.` : ''} All rights reserved.</p>
    <p>
      <a href="/privacy">Privacy Policy</a>
      <a href="/terms">Terms of Service</a>
      <a href="/cookie-policy">Cookie Policy</a>
    </p>
  </footer>
</body>
</html>`;
}

// ── Platform legal pages ─────────────────────────────────────────────────────
//
// Sourced from the same legal_documents rows the admin Legal Documents screen
// writes and the SPA renders, so this text exists in one place rather than two.
// The previous hardcoded Italian copy named a single tenant and silently drifted
// out of step with whatever the admin had actually published.

type LegalDocKey = 'privacy' | 'terms' | 'cookie';

const LEGAL_PATHS: Record<string, LegalDocKey> = {
  '/privacy': 'privacy',
  '/terms': 'terms',
  '/cookie-policy': 'cookie',
};

interface PlatformLegalDoc {
  title: string;
  content: string;
  platform_company_name: string | null;
  platform_company_email: string | null;
}

async function loadPlatformLegalDoc(
  key: LegalDocKey,
  lang: 'it' | 'en',
): Promise<PlatformLegalDoc | null> {
  return queryOne<PlatformLegalDoc>(
    `SELECT title, content, platform_company_name, platform_company_email
       FROM legal_documents
      WHERE document_key = $1 AND language = $2`,
    [key, lang],
  );
}

/**
 * Fills the {{companyName}} / {{companyEmail}} placeholders.
 *
 * These are platform-level pages with no company in the path, so the only
 * correct substitution is the platform identity. An unset field resolves to an
 * empty string — deliberately blank rather than defaulted to any tenant's name.
 */
function renderPlatformLegalHtml(doc: PlatformLegalDoc): string {
  const name = doc.platform_company_name ?? '';
  const email = doc.platform_company_email ?? '';

  const body = (doc.content ?? '')
    .replace(/\{\{companyName\}\}/g, escapeHtml(name))
    .replace(/\{\{companyEmail\}\}/g, escapeHtml(email));

  // Stored content may be HTML or plain text/markdown-ish; only the latter needs
  // wrapping in paragraphs.
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(body);
  const rendered = looksLikeHtml
    ? body
    : body
        .split(/\n{2,}/)
        .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br />')}</p>`)
        .join('\n');

  return `
    <div class="card">
      <h2>${escapeHtml(doc.title ?? '')}</h2>
      <div class="rich-text">
${rendered}
      </div>
    </div>
  `;
}

export const ssrRendererMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const rawPath = req.path.toLowerCase().replace(/\/$/, ''); // Normalize trailing slash
  const isSsrPrefix = rawPath.startsWith('/ssr/');
  const path = isSsrPrefix ? rawPath.substring(4) : rawPath;

  const userAgent = req.get('user-agent') || '';
  const isBot = /Indeedbot|Googlebot|Bingbot|facebookexternalhit|Twitterbot/i.test(userAgent);

  const botRoutes = [
    /^\/careers$/,
    /^\/careers\/.+/,
    /^\/privacy$/,
    /^\/terms$/,
    /^\/cookie-policy$/
  ];

  const isBotRoute = botRoutes.some(regex => regex.test(path));

  // If this is not a route that needs bot-rendering, bypass immediately
  if (!isBotRoute) {
    next();
    return;
  }

  // Platform legal pages (no company in the path).
  //
  // Humans fall through to the SPA redirect below, which renders these from the
  // database already — keeping one rendering path avoids the two copies drifting
  // apart. Only crawlers (and /ssr/ probes) get server-rendered HTML here, built
  // from the same legal_documents row.
  const legalKey = LEGAL_PATHS[path];
  if (legalKey && (isBot || isSsrPrefix)) {
    const lang = (req.query.lang as string) === 'en' ? 'en' : 'it';
    const doc = await loadPlatformLegalDoc(legalKey, lang);

    // Nothing published yet: serve an empty document rather than inventing a
    // Data Controller. Fabricating one would be worse than an incomplete page.
    const brandName = doc?.platform_company_name ?? '';
    const heading = doc?.title ?? '';
    const title = [heading, brandName || PLATFORM_FALLBACK_NAME].filter(Boolean).join(' | ');

    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.send(wrapPageTemplate(title, doc ? renderPlatformLegalHtml(doc) : '', brandName));
    return;
  }

  // If a human hits this on the backend port directly (e.g. testing or deep linking),
  // redirect them to the actual frontend SPA to prevent backend 404s.
  // Bypass this check if the request has the /ssr/ prefix so curl tests can render the page.
  if (!isBot && !isSsrPrefix) {
    const frontendUrl = resolveFrontendBase(req) + req.originalUrl;
    res.redirect(frontendUrl);
    return;
  }

  // --- BOT RENDER START ---
  
  // Check in-memory cache first
  const cacheKey = req.originalUrl; // Keep query params in cache key (e.g. language preferences)
  const cached = renderCache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.send(cached.html);
    return;
  }

  try {
    const frontendBase = resolveFrontendBase(req);

    // Case 1: Job detail page (/careers/jobs/:jobId or /careers/:companySlug/jobs/:jobId)
    const jobDetailMatch = path.match(/^\/careers(?:\/([^/]+))?\/jobs\/(\d+)$/);
    if (jobDetailMatch) {
      const companySlug = jobDetailMatch[1]; // Optional
      const jobId = parseInt(jobDetailMatch[2], 10);

      const jobRow = await getPublicJobById(jobId, companySlug);
      if (!jobRow) {
        res.status(404).setHeader('Content-Type', 'text/html; charset=UTF-8').send(`<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <title>Posizione non trovata</title>
</head>
<body>
  <h1>Posizione non trovata</h1>
  <p>L'annuncio cercato non è disponibile o è stato rimosso.</p>
</body>
</html>`);
        return;
      }

      const job = mapPublicJob(jobRow);

      // Strip HTML tags for meta description (simple regex replace)
      const plainDesc = (job.description || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const shortDesc = plainDesc.slice(0, 160);

      // JSON-LD JobPosting schema mapping
      const mapEmploymentType = (jobType: string | null | undefined): string => {
        const t = (jobType || '').toLowerCase().replace(/[-_]/g, '');
        if (t === 'fulltime') return 'FULL_TIME';
        if (t === 'parttime') return 'PART_TIME';
        if (t === 'contractor') return 'CONTRACTOR';
        return 'FULL_TIME';
      };

      const ldJson = {
        "@context": "https://schema.org",
        "@type": "JobPosting",
        "title": job.title,
        "description": plainDesc.slice(0, 5000),
        "datePosted": job.published_at ? new Date(job.published_at).toISOString() : new Date(job.created_at).toISOString(),
        "employmentType": mapEmploymentType(job.job_type),
        "hiringOrganization": {
          "@type": "Organization",
          "name": job.company_name
        },
        "jobLocation": {
          "@type": "Place",
          "address": {
            "@type": "PostalAddress",
            "addressLocality": job.job_city || '',
            "addressRegion": job.job_state || '',
            "postalCode": job.job_postal_code || '',
            "addressCountry": job.job_country || 'IT'
          }
        }
      };

      // Construct salary HTML block if salary_min is present
      let salaryHtml = '';
      if (job.salary_min != null) {
        const maxPart = job.salary_max != null ? `–${job.salary_max}` : '';
        // Render the Italian period label rather than the raw stored token.
        const periodLabel = salaryPeriodItalianLabel(job.salary_period);
        const periodPart = periodLabel ? ` ${periodLabel}` : '';
        salaryHtml = `<p>Stipendio: ${job.salary_min}${maxPart}${periodPart}</p>`;
      }

      // Never fall back to a specific tenant's slug — a wrong slug here would
      // emit a canonical URL pointing at another company's careers page.
      const companySlugForUrl = companySlug || job.company_slug || '';

      const html = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(job.title)} | ${escapeHtml(job.company_name)}</title>
  <meta name="description" content="${escapeHtml(shortDesc)}">
  <meta property="og:title" content="${escapeHtml(job.title)}">
  <meta property="og:description" content="${escapeHtml(shortDesc)}">
  <link rel="canonical" href="https://veylohr.com/careers/${escapeHtml(companySlugForUrl)}/jobs/${jobId}">
  <script type="application/ld+json">
  ${JSON.stringify(ldJson, null, 2)}
  </script>
</head>
<body>
  <nav><a href="https://veylohr.com/careers/${escapeHtml(companySlugForUrl)}">${escapeHtml(job.company_name)} — Posizioni aperte</a></nav>
  <main>
    <h1>${escapeHtml(job.title)}</h1>
    <p>${escapeHtml(job.job_city || '')}, ${escapeHtml(job.job_country || '')}</p>
    <p>${escapeHtml(job.company_name)}</p>
    ${salaryHtml}
    <section>${job.description || ''}</section>
    <a href="https://veylohr.com/careers/${escapeHtml(companySlugForUrl)}/jobs/${jobId}">
      Candidati per questa posizione
    </a>
  </main>
</body>
</html>`;

      // Cache result
      renderCache.set(cacheKey, { html, expiry: Date.now() + CACHE_TTL_MS });

      res.setHeader('Content-Type', 'text/html; charset=UTF-8');
      res.send(html);
      return;
    }

    // Case 2: Careers index page (/careers or /careers/:companySlug)
    const indexMatch = path.match(/^\/careers(?:\/([^/]+))?$/);
    if (indexMatch) {
      const companySlug = indexMatch[1]; // Optional
      const jobRows = await listPublicJobs(companySlug);
      
      let companyName = 'Tutte le aziende';
      if (companySlug) {
        const companyRow = await getPublicCompanyBySlug(companySlug);
        if (companyRow) {
          companyName = companyRow.name;
        }
      }

      const jobCards = jobRows.map(row => {
        const job = mapPublicJob(row);
        const detailUrl = `/careers/${job.company_slug}/jobs/${job.id}`;
        const locationText = job.remote_type === 'remote' ? 'Remoto' : `${job.job_city || ''}, ${job.job_state || ''}`.replace(/^,\s*/, '');
        const snippet = (job.description ?? '')
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 180) + '...';

        return `
          <article class="job-card">
            <h3>${escapeHtml(job.title)}</h3>
            <div class="meta-group" style="margin-bottom: 12px;">
              <span class="badge primary">${escapeHtml(job.company_name)}</span>
              <span class="badge">${escapeHtml(locationText)}</span>
              <span class="badge">${escapeHtml(job.job_type)}</span>
            </div>
            <p>${escapeHtml(snippet)}</p>
            <a href="${escapeHtml(detailUrl)}" class="job-card-link">Leggi Dettagli / View Details &rarr;</a>
          </article>
        `;
      }).join('\n');

      const content = `
        <div style="margin-bottom: 30px;">
          <h2>Posizioni Aperte a ${escapeHtml(companyName)}</h2>
          <p>Esplora le opportunità di carriera e unisciti al nostro team.</p>
        </div>
        <div class="job-list">
          ${jobCards || '<div class="card" style="text-align: center;"><p>Al momento non ci sono posizioni aperte.</p></div>'}
        </div>
      `;

      const title = `Posizioni Aperte presso ${companyName} | Careers`;
      const html = wrapPageTemplate(title, content);

      // Cache result
      renderCache.set(cacheKey, { html, expiry: Date.now() + CACHE_TTL_MS });

      res.setHeader('Content-Type', 'text/html; charset=UTF-8');
      res.send(html);
      return;
    }

    // Default fallback
    next();
  } catch (error) {
    console.error('[SSR_RENDERER_MIDDLEWARE] Failed to render bot page:', error);
    next();
  }
};
