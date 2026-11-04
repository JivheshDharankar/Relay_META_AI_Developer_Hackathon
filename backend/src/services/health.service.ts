import { env } from '../config/env';
import { HealthStatus } from '../domain';
import { healthRepository } from '../repositories/health.repository';
import { MetaModelProvider } from '../agent/model/MetaModelProvider';
import { GeoapifySupplierProvider } from '../discovery/supplier/GeoapifySupplierProvider';
import { SupplierDiscoveryError } from '../discovery/supplier/SupplierDiscoveryProvider';

export interface MetaDiagnosticResult {
  status: 'success' | 'error' | 'not_configured';
  configured: boolean;
  model: string;
  detail: string;
}

export interface GeoapifyDiagnosticResult {
  status: 'success' | 'error' | 'not_configured';
  configured: boolean;
  suppliersCount: number;
  detail: string;
}

export interface IntegrationDiagnosticsResult {
  meta: MetaDiagnosticResult;
  geoapify: GeoapifyDiagnosticResult;
}

export class HealthService {
  public async getHealth(): Promise<HealthStatus> {
    const dbPing = await healthRepository.pingDatabase();

    const isHealthy = dbPing.connected;

    return {
      status: isHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      environment: env.NODE_ENV,
      version: '0.1.0',
      database: {
        status: dbPing.connected ? 'connected' : 'disconnected',
        latencyMs: dbPing.latencyMs,
        ...(dbPing.error ? { error: dbPing.error } : {}),
      },
    };
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private async testMeta(): Promise<MetaDiagnosticResult> {
    try {
      const provider = new MetaModelProvider();
      const configStatus = provider.getConfigStatus();
      if (!configStatus.configured) {
        return {
          status: 'not_configured',
          configured: false,
          model: configStatus.model || env.META_MODEL_NAME || 'muse-spark-1.3',
          detail: configStatus.reason,
        };
      }
      const res = await provider.probeConnectivity();
      return {
        status: res.status,
        configured: true,
        model: configStatus.model,
        detail: res.detail,
      };
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      const sanitized = raw.replace(/Bearer\s+[a-zA-Z0-9_\-.]+/gi, 'Bearer [REDACTED]').slice(0, 512);
      return {
        status: 'error',
        configured: false,
        model: env.META_MODEL_NAME || 'muse-spark-1.3',
        detail: sanitized,
      };
    }
  }

  private async testGeoapify(): Promise<GeoapifyDiagnosticResult> {
    try {
      const provider = new GeoapifySupplierProvider();
      const candidates = await provider.discoverSuppliers({
        coordinates: { latitude: 18.5204, longitude: 73.8567 },
        radiusMeters: 5000,
        limit: 3,
      });
      return {
        status: 'success',
        configured: true,
        suppliersCount: candidates.length,
        detail: `Successfully discovered ${candidates.length} supplier candidate(s) in search radius.`,
      };
    } catch (err: unknown) {
      const isMissingKey =
        err instanceof SupplierDiscoveryError
          ? err.code === 'MISSING_API_KEY'
          : String(err).includes('MISSING_API_KEY') || !env.GEOAPIFY_API_KEY;
      const raw = err instanceof Error ? err.message : String(err);
      // Sanitize any apiKey or query param that might leak credentials
      const sanitized = raw
        .replace(/apiKey=[^&\s"']+/gi, 'apiKey=[REDACTED]')
        .slice(0, 512);

      return {
        status: isMissingKey ? 'not_configured' : 'error',
        configured: !isMissingKey,
        suppliersCount: 0,
        detail: sanitized,
      };
    }
  }

  /**
   * Concurrently tests Meta Model and Geoapify integrations using Promise.allSettled.
   * Never mutates state or databases.
   */
  public async testIntegrations(): Promise<IntegrationDiagnosticsResult> {
    const [metaSettled, geoSettled] = await Promise.allSettled([
      this.withTimeout(this.testMeta(), 15000, 'Meta Model probe'),
      this.withTimeout(this.testGeoapify(), 15000, 'Geoapify probe'),
    ]);

    const meta: MetaDiagnosticResult =
      metaSettled.status === 'fulfilled'
        ? metaSettled.value
        : {
            status: 'error',
            configured: false,
            model: env.META_MODEL_NAME || 'muse-spark-1.3',
            detail: metaSettled.reason instanceof Error ? metaSettled.reason.message : String(metaSettled.reason),
          };

    const geoapify: GeoapifyDiagnosticResult =
      geoSettled.status === 'fulfilled'
        ? geoSettled.value
        : {
            status: 'error',
            configured: false,
            suppliersCount: 0,
            detail: geoSettled.reason instanceof Error ? geoSettled.reason.message : String(geoSettled.reason),
          };

    return { meta, geoapify };
  }
}

export const healthService = new HealthService();

