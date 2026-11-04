export interface RateLimitPolicy {
  maxRequests: number;
  windowSeconds: number;
}

export const DEFAULT_RATE_POLICIES: Record<string, RateLimitPolicy> = {
  AUTH_ATTEMPT: { maxRequests: 5, windowSeconds: 60 },
  OTP_REQUEST: { maxRequests: 3, windowSeconds: 120 },
  SOCIETY_SEARCH: { maxRequests: 30, windowSeconds: 60 },
  PROFILE_MUTATION: { maxRequests: 10, windowSeconds: 60 },
  ONBOARDING_MUTATION: { maxRequests: 15, windowSeconds: 60 },
  SENSITIVE_API: { maxRequests: 20, windowSeconds: 60 },
  AGENT_RUN: { maxRequests: 30, windowSeconds: 60 },
  PAYMENT_EXECUTION: { maxRequests: 60, windowSeconds: 60 },
  PROCUREMENT_MUTATION: { maxRequests: 60, windowSeconds: 60 },
};

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAfterSeconds: number;
  limit: number;
}

export class RateLimiterService {
  private requestLog = new Map<string, number[]>(); // key -> timestamps[]

  /**
   * Deterministically evaluates rate limit using sliding window algorithm.
   */
  public checkLimit(
    key: string,
    policy: RateLimitPolicy = { maxRequests: 60, windowSeconds: 60 },
    now: number = Date.now()
  ): RateLimitResult {
    const windowMs = policy.windowSeconds * 1000;
    const windowStart = now - windowMs;

    const timestamps = this.requestLog.get(key) || [];
    // Clean up timestamps outside window
    const activeTimestamps = timestamps.filter((t) => t > windowStart);

    const allowed = activeTimestamps.length < policy.maxRequests;
    const remaining = Math.max(0, policy.maxRequests - activeTimestamps.length - (allowed ? 1 : 0));

    let oldestTimestamp = activeTimestamps[0] || now;
    let resetAfterSeconds = Math.ceil((oldestTimestamp + windowMs - now) / 1000);
    if (resetAfterSeconds <= 0) resetAfterSeconds = policy.windowSeconds;

    if (allowed) {
      activeTimestamps.push(now);
      this.requestLog.set(key, activeTimestamps);
    }

    return {
      allowed,
      remaining,
      resetAfterSeconds,
      limit: policy.maxRequests,
    };
  }

  public reset(key: string): void {
    this.requestLog.delete(key);
  }

  public clear(): void {
    this.requestLog.clear();
  }
}

export const rateLimiterService = new RateLimiterService();

