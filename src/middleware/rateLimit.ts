import { Request, Response, NextFunction } from 'express';

/**
 * Minimal in-memory, fixed-window rate limiter.
 *
 * Dependency-free on purpose (no external package / supply-chain surface). It is
 * per-process — good enough as a first line of defence against abuse/spam of a
 * public endpoint. For a multi-instance deployment a shared store (Redis) would
 * be needed for a hard global limit; here it still caps volume per instance.
 *
 * Keyed by client IP (Express `trust proxy` is enabled, so `req.ip` is the real
 * client address behind the proxy).
 */
interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per key within the window. */
  max: number;
  /** Namespace so multiple limiters don't share buckets. */
  keyPrefix?: string;
  /** Message sent with the 429 response. */
  message?: string;
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, keyPrefix = 'rl', message = 'Too Many Requests' } = options;
  const buckets = new Map<string, Bucket>();

  // Evict expired buckets periodically so the Map cannot grow unbounded.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs);
  // Do not keep the event loop alive just for the sweeper.
  if (typeof sweep.unref === 'function') sweep.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));

    if (bucket.count > max) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).send(message);
      return;
    }

    next();
  };
}
