import { logger } from '../utils/logger.js';
import { sessionCache } from '../session/cache.js';

const WCL_API_ENDPOINT = 'https://www.warcraftlogs.com/api/v2/client';
const WCL_TOKEN_ENDPOINT = 'https://www.warcraftlogs.com/oauth/token';

// Retry config
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_JITTER_MS = 500;
const DEFAULT_RATE_LIMIT_WAIT_MS = 30_000;

// Circuit breaker config
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_RESET_TIMEOUT_MS = 60_000;

type CircuitState = 'closed' | 'open' | 'half-open';

interface TokenInfo {
  accessToken: string;
  expiresAt: number;
}

export class WCLClient {
  private clientId: string;
  private clientSecret: string;
  private token: TokenInfo | null = null;

  // Circuit breaker state
  private circuitState: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;

  constructor(clientId: string, clientSecret: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  /**
   * Execute a GraphQL query with cache-first strategy.
   * If cacheKey is provided, checks session cache before querying.
   */
  async query<T>(
    graphqlQuery: string,
    variables: Record<string, unknown>,
    cacheKey?: string,
  ): Promise<T> {
    // Cache-first
    if (cacheKey) {
      const cached = sessionCache.get(cacheKey);
      if (cached !== undefined) {
        logger.wclQuery('cached', { latencyMs: 0, cacheHit: true, success: true });
        return cached as T;
      }
    }

    const startTime = Date.now();
    const result = await this.executeWithRetry<T>(graphqlQuery, variables);
    const latencyMs = Date.now() - startTime;

    logger.wclQuery('live', { latencyMs, cacheHit: false, success: true });

    // Cache the result
    if (cacheKey) {
      sessionCache.set(cacheKey, result);
    }

    return result;
  }

  private async executeWithRetry<T>(
    graphqlQuery: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    // Check circuit breaker
    if (this.circuitState === 'open') {
      if (Date.now() - this.circuitOpenedAt >= CIRCUIT_RESET_TIMEOUT_MS) {
        this.circuitState = 'half-open';
        logger.info('Circuit breaker half-open, allowing probe request');
      } else {
        throw new WCLError('service_unavailable', 'WCL API circuit breaker is open. Too many consecutive failures.');
      }
    }

    let lastError: Error | undefined;
    let refreshed = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await this.executeSingle<T>(graphqlQuery, variables);
        this.onSuccess();
        return result;
      } catch (error) {
        lastError = error as Error;

        if (error instanceof WCLError) {
          // Token expired -- refresh and retry once
          if (error.code === 'auth_expired' && !refreshed && attempt < MAX_RETRIES) {
            this.token = null;
            refreshed = true;
            continue;
          }

          // Rate limited -- wait and retry
          if (error.code === 'rate_limited' && attempt < MAX_RETRIES) {
            const waitMs = error.retryAfter
              ? error.retryAfter * 1000
              : DEFAULT_RATE_LIMIT_WAIT_MS;
            logger.warn('Rate limited, waiting', { waitMs });
            await sleep(waitMs);
            continue;
          }

          // Non-retryable client errors
          if (error.code === 'auth_failure' || error.code === 'client_error' || error.code === 'graphql_error' || error.code === 'missing_configuration') {
            this.onFailure();
            throw error;
          }
        }

        // Server error or timeout -- retry with backoff
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * MAX_JITTER_MS;
          logger.warn('Retrying WCL query', { attempt: attempt + 1, delayMs: Math.round(delay) });
          await sleep(delay);
        }
      }
    }

    this.onFailure();
    throw lastError ?? new WCLError('service_unavailable', 'WCL query failed after retries');
  }

  private async executeSingle<T>(
    graphqlQuery: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const token = await this.getToken();

    const response = await fetch(WCL_API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ query: graphqlQuery, variables }),
      signal: AbortSignal.timeout(30000),
    });

    if (response.status === 401) {
      throw new WCLError('auth_expired', 'Token expired');
    }

    if (response.status === 429) {
      const header = response.headers.get('Retry-After') ?? '';
      const retryAfter = /^\d+$/.test(header) ? Number(header) : Math.max(0, (Date.parse(header)-Date.now())/1000);
      throw new WCLError('rate_limited', 'Rate limited', isNaN(retryAfter) ? undefined : retryAfter);
    }

    if (response.status >= 500) {
      throw new WCLError('server_error', `WCL returned ${response.status}`);
    }

    if (!response.ok) {
      throw new WCLError('client_error', `WCL returned ${response.status}`);
    }

    const json = await response.json() as { data?: T; errors?: Array<{ message: string }> };

    if (json.errors && json.errors.length > 0) {
      const msg = json.errors.map(e => e.message).join('; ');
      throw new WCLError('graphql_error', `GraphQL errors: ${msg}`);
    }

    if (!json.data) {
      throw new WCLError('graphql_error', 'No data in GraphQL response');
    }

    return json.data;
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) {
      return this.token.accessToken;
    }

    if (!this.clientId || !this.clientSecret) throw new WCLError('missing_configuration', 'Set WCL_CLIENT_ID and WCL_CLIENT_SECRET in the local .env (see .env). Do not send secrets in chat.');
    logger.info('Fetching new WCL access token');

    const response = await fetch(WCL_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      if (response.status >= 500) throw new WCLError('server_error', `Token endpoint returned ${response.status}`);
      if (response.status === 429) throw new WCLError('rate_limited', 'Token endpoint rate limited', Number(response.headers.get('Retry-After')) || undefined);
      throw new WCLError('auth_failure', `Failed to get WCL token: ${response.status}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    this.token = {
      accessToken: data.access_token,
      // Refresh 60s early to avoid edge cases
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };

    return this.token.accessToken;
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.circuitState === 'half-open') {
      this.circuitState = 'closed';
      logger.info('Circuit breaker closed');
    }
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      logger.error('Circuit breaker opened', { consecutiveFailures: this.consecutiveFailures });
    }
  }
}

export class WCLError extends Error {
  code: string;
  retryAfter?: number;

  constructor(code: string, message: string, retryAfter?: number) {
    super(message);
    this.name = 'WCLError';
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
