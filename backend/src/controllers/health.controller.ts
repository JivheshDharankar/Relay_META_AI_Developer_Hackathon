import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { healthService } from '../services/health.service';
import { env } from '../config/env';

/**
 * Validates the diagnostic Bearer token using a constant-time comparison.
 * Fails closed if INTEGRATION_DIAGNOSTIC_TOKEN is unconfigured or empty.
 */
function isDiagnosticAuthorized(authHeader?: string): boolean {
  const expectedToken = (env.INTEGRATION_DIAGNOSTIC_TOKEN || process.env.INTEGRATION_DIAGNOSTIC_TOKEN || '').trim();
  if (expectedToken.length === 0) {
    return false;
  }
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const providedToken = authHeader.slice(7).trim();
  if (providedToken.length === 0) {
    return false;
  }

  const providedBuf = Buffer.from(providedToken);
  const expectedBuf = Buffer.from(expectedToken);
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

export class HealthController {
  public async getHealth(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const health = await healthService.getHealth();
      const statusCode = health.status === 'ok' ? 200 : 503;
      res.status(statusCode).json(health);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/health/integrations
   * Authenticated diagnostic probe for Meta Model API and Geoapify Places API.
   * Requires Bearer token matching INTEGRATION_DIAGNOSTIC_TOKEN.
   */
  public async testIntegrations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const authHeader = req.headers.authorization;
      if (!isDiagnosticAuthorized(authHeader)) {
        res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid diagnostic token. Provide a valid Bearer token in the Authorization header.',
          },
        });
        return;
      }

      const diagnostics = await healthService.testIntegrations();
      res.status(200).json({
        success: true,
        timestamp: new Date().toISOString(),
        diagnostics,
      });
    } catch (err) {
      next(err);
    }
  }
}

export const healthController = new HealthController();

