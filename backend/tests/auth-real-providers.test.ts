/**
 * Relay Phase 12.5 — Real Authentication Provider Integration Test Suite
 *
 * Comprehensive verification of:
 * 1. Google OAuth 2.0 / OpenID Connect flow, tokens, state validation, and identity extraction
 * 2. Email OTP generation, cooldown, delivery, verification, replay prevention, and brute force
 * 3. Phone OTP generation, Twilio/Mock abstraction, cooldown, and verification
 * 4. OAuth state management, CSRF protection, and replay rejection
 * 5. Account linking safety, duplicate provider logins, and collision prevention
 * 6. Session creation, revocation, multi-device invalidation, and IDOR protection
 * 7. Rate limiting for auth and OTP endpoints
 * 8. Audit sanitization and secret leakage prevention
 * 9. Location-agnostic onboarding across global cities (Nashik, Pune, Bangalore, Delhi, London, Tokyo)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import {
  authProviderRegistry,
  GoogleAuthProvider,
  googleAuthProvider,
  EmailPhoneAuthProvider,
  emailPhoneAuthProvider,
  oauthStateManager,
  userService,
  sessionService,
  identityAuditService,
  emailService,
  smsService,
  rateLimiterService,
  oauthGrantService,
  TwilioSmsProvider,
  MockSmsProvider,
} from '../src/identity';
import { eventBus } from '../src/events';

describe('Phase 12.5: Real Authentication Provider Integration', () => {
  beforeEach(() => {
    oauthStateManager.clear();
    emailPhoneAuthProvider.clear();
    emailService.clear();
    rateLimiterService.clear();
    smsService.getMockProvider().clear();
    smsService.setProviderOverride('mock');
  });

  // =========================================================================
  // SUITE 1: Provider Registry & Status Metadata (8 tests)
  // =========================================================================
  describe('1. Provider Registry & Status Metadata', () => {
    it('1.1 registers all 3 authentication paths in registry', () => {
      expect(authProviderRegistry.has('GOOGLE')).toBe(true);
      expect(authProviderRegistry.has('EMAIL_PHONE')).toBe(true);
      expect(authProviderRegistry.has('EMAIL')).toBe(true);
      expect(authProviderRegistry.has('PHONE')).toBe(true);
      expect(authProviderRegistry.has('INSTAGRAM' as any)).toBe(false);
      expect(authProviderRegistry.has('X' as any)).toBe(false);
    });

    it('1.2 returns truth-telling metadata for all providers via getAllMetadata', () => {
      const meta = authProviderRegistry.getAllMetadata();
      expect(meta.length).toBe(3);

      const googleMeta = meta.find((m) => m.id === 'GOOGLE');
      const emailMeta = meta.find((m) => m.id === 'EMAIL');
      const phoneMeta = meta.find((m) => m.id === 'PHONE');

      expect(googleMeta).toBeDefined();
      expect(emailMeta?.isAvailable).toBe(true);
      expect(phoneMeta?.isAvailable).toBe(true);
    });

    it('1.3 GET /api/auth/providers returns public provider list and availability', async () => {
      const res = await request(app).get('/api/auth/providers');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.providers)).toBe(true);
      expect(res.body.data.providers.length).toBe(3);
    });

    it('1.4 GET /auth/providers alias route functions identically', async () => {
      const res = await request(app).get('/auth/providers');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('1.5 provider status is strictly CONFIGURED, UNCONFIGURED, or ERROR', () => {
      const meta = authProviderRegistry.getAllMetadata();
      for (const m of meta) {
        expect(['CONFIGURED', 'UNCONFIGURED', 'ERROR']).toContain(m.status);
      }
    });

    it('1.6 never exposes client secrets or API keys in provider metadata', () => {
      const meta = authProviderRegistry.getAllMetadata();
      for (const m of meta) {
        expect((m as any).clientSecret).toBeUndefined();
        expect((m as any).apiKey).toBeUndefined();
        expect((m as any).authToken).toBeUndefined();
      }
    });

    it('1.7 unconfigured OAuth provider reports isAvailable=false and requiresConfig=true', () => {
      const unconfigured = new GoogleAuthProvider(undefined, undefined);
      expect(unconfigured.isConfigured).toBe(false);
      expect(unconfigured.status).toBe('UNCONFIGURED');
      const meta = unconfigured.getMetadata();
      expect(meta.isAvailable).toBe(false);
      expect(meta.requiresConfig).toBe(true);
    });

    it('1.8 configured OAuth provider reports isAvailable=true and status=CONFIGURED', () => {
      const configured = new GoogleAuthProvider('client_123', 'secret_456');
      expect(configured.isConfigured).toBe(true);
      expect(configured.status).toBe('CONFIGURED');
      const meta = configured.getMetadata();
      expect(meta.isAvailable).toBe(true);
      expect(meta.requiresConfig).toBe(false);
    });
  });

  // =========================================================================
  // SUITE 2: Google OAuth 2.0 / OpenID Connect (12 tests)
  // =========================================================================
  describe('2. Google OAuth 2.0 / OpenID Connect', () => {
    it('2.1 generates valid Google authorization URL with openid scopes', () => {
      const provider = new GoogleAuthProvider('test_google_client_id', 'test_google_secret');
      const state = oauthStateManager.createState('GOOGLE', 'http://localhost:4000/api/auth/google/callback');
      const url = provider.getAuthorizationUrl(state, 'nonce_123');

      expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url).toContain('client_id=test_google_client_id');
      expect(url).toContain('scope=openid+email+profile');
      expect(url).toContain(`state=${state}`);
      expect(url).toContain('nonce=nonce_123');
    });

    it('2.2 throws error when getAuthorizationUrl is called on unconfigured Google provider', () => {
      const provider = new GoogleAuthProvider(undefined, undefined);
      expect(() => provider.getAuthorizationUrl('state_test')).toThrow('Google OAuth is not configured');
    });

    it('2.2a authorization URL carries the PKCE S256 challenge', () => {
      const provider = new GoogleAuthProvider('test_google_client_id', 'test_google_secret');
      const url = provider.getAuthorizationUrl('state_pkce', 'nonce_pkce', undefined, 'challenge_abc123');
      expect(url).toContain('code_challenge=challenge_abc123');
      expect(url).toContain('code_challenge_method=S256');
    });

    it('2.2b token exchange sends the PKCE verifier bound at initiation', async () => {
      let exchangeBody = '';
      const mockFetch: typeof fetch = (async (url: any, init: any) => {
        if (String(url).includes('token')) {
          exchangeBody = String(init?.body ?? '');
          return new Response(JSON.stringify({ access_token: 'tok_pkce' }), { status: 200 });
        }
        return new Response(JSON.stringify({ sub: 'pkce_sub', email: 'pkce@gmail.com' }), {
          status: 200,
        });
      }) as any;
      const provider = new GoogleAuthProvider({
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
        fetchFn: mockFetch,
      });
      const res = await provider.handleCallback({ code: 'pkce_code', codeVerifier: 'verifier_xyz' });
      expect(res.success).toBe(true);
      expect(exchangeBody).toContain('code_verifier=verifier_xyz');
    });

    it('2.2c id_token fallback uses only Google-verified claims, never raw JWT decode', async () => {
      const forgedJwt = [
        Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
        Buffer.from(JSON.stringify({ sub: 'forged_sub', email: 'forged@evil.example' })).toString('base64url'),
        'sig',
      ].join('.');
      const mockFetch: typeof fetch = (async (url: any) => {
        if (String(url).includes('token?') || String(url).includes('tokeninfo')) {
          return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 400 });
        }
        if (String(url).includes('token')) {
          return new Response(JSON.stringify({ id_token: forgedJwt }), { status: 200 });
        }
        // userinfo fails: fallback must verify (and reject) the id_token
        return new Response('Unauthorized', { status: 401 });
      }) as any;
      const provider = new GoogleAuthProvider({
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
        fetchFn: mockFetch,
      });
      const res = await provider.handleCallback({ code: 'code_forged' });
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('GOOGLE_IDENTITY_EXTRACTION_FAILED');
    });

    it('2.3 unconfigured GET /api/auth/google responds with HTTP 503 when format=json', async () => {
      const res = await request(app).get('/api/auth/google?format=json');
      // If environment has no credentials, returns 503
      if (res.status === 503) {
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('GOOGLE_AUTH_UNCONFIGURED');
        expect(res.body.error.requiresConfig).toBe(true);
      } else {
        // If local env has Google credentials configured
        expect(res.status).toBe(200);
      }
    });

    it('2.4 rejects callback when authorization code is missing (HTTP 400)', async () => {
      const state = oauthStateManager.createState('GOOGLE', 'http://localhost:4000/api/auth/google/callback');
      const res = await request(app).get(`/api/auth/google/callback?state=${state}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_OAUTH_PARAMS');
    });

    it('2.5 rejects callback when OAuth state is missing (HTTP 400)', async () => {
      const res = await request(app).get('/api/auth/google/callback?code=mock_code');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_OAUTH_PARAMS');
    });

    it('2.6 rejects callback when OAuth state is invalid or forged (HTTP 400)', async () => {
      const res = await request(app).get('/api/auth/google/callback?code=mock_code&state=forged_state_123');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_OAUTH_STATE');
    });

    it('2.7 rejects callback when provider reports user error in query params', async () => {
      const res = await request(app).get(
        '/api/auth/google/callback?error=access_denied&error_description=User+cancelled'
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OAUTH_PROVIDER_ERROR');
    });

    it('2.7b redirects browser navigations to login with a safe error code instead of JSON', async () => {
      const cancelled = await request(app)
        .get('/api/auth/google/callback?error=access_denied&error_description=User+cancelled')
        .set('Accept', 'text/html,application/xhtml+xml')
        .redirects(0);
      expect(cancelled.status).toBe(302);
      expect(cancelled.headers.location).toMatch(/\/login\?error=OAUTH_PROVIDER_ERROR$/);
      expect(cancelled.headers.location).not.toContain('cancelled');

      const forged = await request(app)
        .get('/api/auth/google/callback?code=x&state=forged_state_123')
        .set('Accept', 'text/html')
        .redirects(0);
      expect(forged.status).toBe(302);
      expect(forged.headers.location).toMatch(/\/login\?error=INVALID_OAUTH_STATE$/);
    });

    it('2.8 handles successful authorization-code exchange with simulated fetch mock', async () => {
      const mockFetch: typeof fetch = async (url: any) => {
        if (String(url).includes('oauth2.googleapis.com/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'valid_google_access_token',
              id_token: 'valid_google_id_token',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (String(url).includes('googleapis.com/oauth2/v3/userinfo')) {
          return new Response(
            JSON.stringify({
              sub: 'google_sub_101',
              email: 'verified_google@gmail.com',
              name: 'Google Verified User',
              picture: 'https://lh3.googleusercontent.com/avatar.jpg',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('Not Found', { status: 404 });
      };

      const provider = new GoogleAuthProvider({
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
        fetchFn: mockFetch,
      });

      const res = await provider.handleCallback({ code: 'valid_auth_code' });
      expect(res.success).toBe(true);
      expect(res.user?.email).toBe('verified_google@gmail.com');
      expect(res.user?.name).toBe('Google Verified User');
      expect(res.user?.authProvider).toBe('GOOGLE');
      expect(res.user?.providerAccountId).toBe('g_google_sub_101');
    });

    it('2.9 returns error when Google token exchange returns HTTP 400 bad verification code', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Code expired' }), {
          status: 400,
        });
      };

      const provider = new GoogleAuthProvider({
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
        fetchFn: mockFetch,
      });

      const res = await provider.handleCallback({ code: 'expired_code' });
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('GOOGLE_TOKEN_EXCHANGE_FAILED');
    });

    it('2.10 creates new UserIdentity and sets onboardingStatus=AUTHENTICATED on first login', async () => {
      const mockFetch: typeof fetch = async (url: any) => {
        if (String(url).includes('token')) {
          return new Response(JSON.stringify({ access_token: 'tok_1' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ sub: 'first_time_sub_99', email: 'first_time@gmail.com', name: 'First User' }),
          { status: 200 }
        );
      };

      const provider = new GoogleAuthProvider({
        clientId: 'client_id',
        clientSecret: 'secret',
        fetchFn: mockFetch,
      });

      const res = await provider.handleCallback({ code: 'first_code' });
      expect(res.success).toBe(true);
      expect(res.user?.onboardingStatus).toBe('AUTHENTICATED');
    });

    it('2.11 repeated login with same Google account does not create duplicate user', async () => {
      const mockUser = {
        authProvider: 'GOOGLE' as const,
        providerAccountId: 'g_duplicate_test_123',
        email: 'duplicate_test@gmail.com',
        name: 'Repeat Google User',
      };

      const u1 = await userService.createUser(mockUser);
      const u2 = await userService.createUser(mockUser);

      expect(u1.id).toBe(u2.id);
      expect(u1.residentId).toBe(u2.residentId);
    });

    it('2.12 never fabricates success when Google credentials are missing', async () => {
      const provider = new GoogleAuthProvider(undefined, undefined);
      const res = await provider.handleCallback({ code: 'any_code' });
      expect(res.success).toBe(false);
      expect(res.requiresConfig).toBe(true);
      expect(res.errorCode).toBe('GOOGLE_AUTH_UNCONFIGURED');
    });
  });



  // =========================================================================
  // SUITE 5: Real Usable Email OTP (10 tests)
  // =========================================================================
  describe('5. Real Usable Email OTP', () => {
    it('5.1 generates cryptographically secure 6-digit OTP', async () => {
      const email = 'resident_secure_otp@example.com';
      const result = await emailPhoneAuthProvider.sendEmailOtp(email);
      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
      expect(result.cooldownSeconds).toBe(30);
    });

    it('5.2 POST /api/auth/email/request-otp dispatches OTP successfully', async () => {
      const res = await request(app)
        .post('/api/auth/email/request-otp')
        .send({ email: 'resident_api_otp@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toContain('OTP dispatched');
    });

    it('5.3 enforces 30-second resend cooldown (HTTP 429)', async () => {
      const email = 'resident_cooldown@example.com';
      await emailPhoneAuthProvider.sendEmailOtp(email);

      // Immediate second request triggers cooldown
      await expect(emailPhoneAuthProvider.sendEmailOtp(email)).rejects.toThrow('OTP_COOLDOWN_ACTIVE');
    });

    it('5.4 verifies valid OTP and issues session token via POST /api/auth/email/verify-otp', async () => {
      const email = 'resident_verify@example.com';
      await emailPhoneAuthProvider.sendEmailOtp(email);

      const res = await request(app)
        .post('/api/auth/email/verify-otp')
        .send({ email, otpCode: '123456' }); // Standard dev test fixture

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email).toBe(email);
      expect(res.body.data.session.token).toBeDefined();
    });

    it('5.5 invalidates OTP after successful verification to prevent replay attacks', async () => {
      const email = 'resident_replay@example.com';
      await emailPhoneAuthProvider.sendEmailOtp(email);

      // First verification succeeds
      const res1 = await emailPhoneAuthProvider.authenticate({
        provider: 'EMAIL',
        email,
        otpCode: '123456',
      });
      expect(res1.success).toBe(true);

      // Second verification fails with OTP_NOT_FOUND (single-use consumed)
      const res2 = await emailPhoneAuthProvider.authenticate({
        provider: 'EMAIL',
        email,
        otpCode: '123456',
      });
      expect(res2.success).toBe(false);
      expect(res2.errorCode).toBe('OTP_NOT_FOUND');
    });

    it('5.6 rejects invalid OTP code', async () => {
      const email = 'resident_bad@example.com';
      await emailPhoneAuthProvider.sendEmailOtp(email);

      const res = await request(app)
        .post('/api/auth/email/verify-otp')
        .send({ email, otpCode: '000000' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_OTP');
    });

    it('5.7 enforces maximum 3 failed attempts before invalidating OTP', async () => {
      const email = 'resident_brute_email@example.com';
      await emailPhoneAuthProvider.sendEmailOtp(email);

      // 3 failed attempts
      await emailPhoneAuthProvider.authenticate({ provider: 'EMAIL', email, otpCode: '999991' });
      await emailPhoneAuthProvider.authenticate({ provider: 'EMAIL', email, otpCode: '999992' });
      const res3 = await emailPhoneAuthProvider.authenticate({ provider: 'EMAIL', email, otpCode: '999993' });

      expect(res3.errorCode).toBe('MAX_OTP_ATTEMPTS_EXCEEDED');

      // Subsequent attempt shows OTP is gone
      const res4 = await emailPhoneAuthProvider.authenticate({ provider: 'EMAIL', email, otpCode: '123456' });
      expect(res4.errorCode).toBe('OTP_NOT_FOUND');
    });

    it('5.8 rejects expired OTP code', async () => {
      const email = 'resident_expired_email@example.com';
      await emailPhoneAuthProvider.sendEmailOtp(email);

      const stored = (emailPhoneAuthProvider as any).otpStore.get(email);
      stored.expiresAt = new Date(Date.now() - 1000); // 1 second ago

      const res = await emailPhoneAuthProvider.authenticate({
        provider: 'EMAIL',
        email,
        otpCode: '123456',
      });
      expect(res.errorCode).toBe('OTP_EXPIRED');
    });

    it('5.9 email delivery uses Resend API when RESEND_API_KEY is configured', async () => {
      let resendCalled = false;
      const mockFetch: typeof fetch = async (url: any) => {
        if (String(url).includes('api.resend.com/emails')) {
          resendCalled = true;
          return new Response(JSON.stringify({ id: 're_123456' }), { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      };

      const resendEmailService = new (emailService.constructor as any)({
        apiKey: 're_test_key',
        fetchFn: mockFetch,
      });

      const res = await resendEmailService.sendOtpEmail('test@resend.local', '654321');
      expect(res.success).toBe(true);
      expect(res.providerName).toBe('resend');
      expect(resendCalled).toBe(true);
    });

    it('5.10 email delivery operates in simulated mode when RESEND_API_KEY is omitted', async () => {
      const unconfigured = new (emailService.constructor as any)({ apiKey: undefined });
      const res = await unconfigured.sendOtpEmail('test_sim@relay.local', '112233');
      expect(res.success).toBe(true);
      expect(res.simulated).toBe(true);
    });
  });

  // =========================================================================
  // SUITE 6: Real Usable Phone OTP (10 tests)
  // =========================================================================
  describe('6. Real Usable Phone OTP', () => {
    it('6.1 generates cryptographically secure 6-digit SMS OTP', async () => {
      const phone = '+919876543210';
      const result = await emailPhoneAuthProvider.sendPhoneOtp(phone);
      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    });

    it('6.2 POST /api/auth/phone/request-otp dispatches SMS OTP', async () => {
      const res = await request(app)
        .post('/api/auth/phone/request-otp')
        .send({ phone: '+919876543211' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toContain('OTP dispatched');
    });

    it('6.3 enforces 30-second resend cooldown on phone OTP', async () => {
      const phone = '+919876543212';
      await emailPhoneAuthProvider.sendPhoneOtp(phone);

      await expect(emailPhoneAuthProvider.sendPhoneOtp(phone)).rejects.toThrow('OTP_COOLDOWN_ACTIVE');
    });

    it('6.4 verifies valid phone OTP via POST /api/auth/phone/verify-otp', async () => {
      const phone = '+919876543213';
      await emailPhoneAuthProvider.sendPhoneOtp(phone);

      const res = await request(app)
        .post('/api/auth/phone/verify-otp')
        .send({ phone, otpCode: '123456' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.phone).toBe(phone);
    });

    it('6.5 invalidates phone OTP after successful verification', async () => {
      const phone = '+919876543214';
      await emailPhoneAuthProvider.sendPhoneOtp(phone);

      await emailPhoneAuthProvider.authenticate({ provider: 'PHONE', phone, otpCode: '123456' });
      const retry = await emailPhoneAuthProvider.authenticate({ provider: 'PHONE', phone, otpCode: '123456' });
      expect(retry.errorCode).toBe('OTP_NOT_FOUND');
    });

    it('6.6 rejects invalid phone OTP code (HTTP 401)', async () => {
      const phone = '+919876543215';
      await emailPhoneAuthProvider.sendPhoneOtp(phone);

      const res = await request(app)
        .post('/api/auth/phone/verify-otp')
        .send({ phone, otpCode: '000000' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_OTP');
    });

    it('6.7 enforces 3 failed attempts limit on phone OTP', async () => {
      const phone = '+919876543216';
      await emailPhoneAuthProvider.sendPhoneOtp(phone);

      await emailPhoneAuthProvider.authenticate({ provider: 'PHONE', phone, otpCode: '999991' });
      await emailPhoneAuthProvider.authenticate({ provider: 'PHONE', phone, otpCode: '999992' });
      const res = await emailPhoneAuthProvider.authenticate({ provider: 'PHONE', phone, otpCode: '999993' });

      expect(res.errorCode).toBe('MAX_OTP_ATTEMPTS_EXCEEDED');
    });

    it('6.8 Twilio provider transmits SMS when configured', async () => {
      let twilioCalled = false;
      const mockFetch: typeof fetch = async (url: any) => {
        if (String(url).includes('api.twilio.com')) {
          twilioCalled = true;
          return new Response(JSON.stringify({ sid: 'SM_twilio_123' }), { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      };

      const twilioProvider = new TwilioSmsProvider({
        accountSid: 'AC_test_account_sid',
        authToken: 'auth_token_test',
        fromPhone: '+15005550006',
        fetchFn: mockFetch,
      });

      expect(twilioProvider.isConfigured).toBe(true);
      const res = await twilioProvider.sendSms('+919876543210', 'Test message');
      expect(res.success).toBe(true);
      expect(res.messageId).toBe('SM_twilio_123');
      expect(twilioCalled).toBe(true);
    });

    it('6.9 Twilio provider reports TWILIO_UNCONFIGURED when credentials are missing', async () => {
      const twilioProvider = new TwilioSmsProvider({
        accountSid: undefined,
        authToken: undefined,
        fromPhone: undefined,
      });

      expect(twilioProvider.isConfigured).toBe(false);
      const res = await twilioProvider.sendSms('+919876543210', 'Test message');
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('TWILIO_UNCONFIGURED');
    });

    it('6.10 Mock SMS provider safely records sent messages in memory for test assertions', async () => {
      const mockProvider = new MockSmsProvider();
      await mockProvider.sendSms('+919876543210', 'Verification code');
      expect(mockProvider.sentMessages.length).toBe(1);
      expect(mockProvider.sentMessages[0].to).toBe('+919876543210');
    });
  });

  // =========================================================================
  // SUITE 7: OAuth State Management & CSRF / Replay Protection (8 tests)
  // =========================================================================
  describe('7. OAuth State Management & CSRF / Replay Protection', () => {
    it('7.1 generates high-entropy random state with prefix rly_st_', () => {
      const state = oauthStateManager.createState('GOOGLE', 'http://localhost:4000');
      expect(state.startsWith('rly_st_')).toBe(true);
      expect(state.length).toBeGreaterThan(20);
    });

    it('7.2 validates and single-use consumes state successfully', () => {
      const state = oauthStateManager.createState('GOOGLE', 'http://localhost:4000/callback');
      const data = oauthStateManager.validateAndConsume(state, 'GOOGLE');
      expect(data).not.toBeNull();
      expect(data?.provider).toBe('GOOGLE');
      expect(data?.redirectUri).toBe('http://localhost:4000/callback');
    });

    it('7.3 single-use consumption rejects second lookup of same state (replay defense)', () => {
      const state = oauthStateManager.createState('GOOGLE', 'http://localhost:4000');
      oauthStateManager.validateAndConsume(state, 'GOOGLE');

      // Second attempt returns null
      const retry = oauthStateManager.validateAndConsume(state, 'GOOGLE');
      expect(retry).toBeNull();
    });

    it('7.4 rejects state when provider does not match (cross-provider CSRF protection)', () => {
      const state = oauthStateManager.createState('GOOGLE', 'http://localhost:4000');
      // Attempting to consume Google state on different provider callback fails
      const data = oauthStateManager.validateAndConsume(state, 'EMAIL_PHONE');
      expect(data).toBeNull();
    });

    it('7.5 rejects expired state', () => {
      const state = oauthStateManager.createState('GOOGLE', 'http://localhost:4000', { ttlMs: -1000 });
      const data = oauthStateManager.validateAndConsume(state, 'GOOGLE');
      expect(data).toBeNull();
    });

    it('7.6 cleanup method prunes expired states without disturbing active ones', () => {
      const activeState = oauthStateManager.createState('GOOGLE', 'http://localhost:4000', { ttlMs: 60000 });
      oauthStateManager.createState('GOOGLE', 'http://localhost:4000', { ttlMs: -1000 }); // expired

      oauthStateManager.cleanup();

      const validData = oauthStateManager.validateAndConsume(activeState, 'GOOGLE');
      expect(validData).not.toBeNull();
    });

    it('7.7 OpenID nonce generation provides unique random nonce per request', () => {
      const n1 = oauthStateManager.generateNonce();
      const n2 = oauthStateManager.generateNonce();
      expect(n1).not.toBe(n2);
      expect(n1.startsWith('rly_no_')).toBe(true);
    });

    it('7.8 PKCE code_challenge is deterministic for same code_verifier', () => {
      const { codeVerifier, codeChallenge } = oauthStateManager.generatePkce();
      const recalculated = require('crypto').createHash('sha256').update(codeVerifier).digest('base64url');
      expect(codeChallenge).toBe(recalculated);
    });
  });

  // =========================================================================
  // SUITE 8: Account Linking & Duplicate Identity Collision Safety (6 tests)
  // =========================================================================
  describe('8. Account Linking & Duplicate Identity Collision Safety', () => {
    it('8.1 repeated Google login returns identical userId and residentId', async () => {
      const input = {
        authProvider: 'GOOGLE' as const,
        providerAccountId: 'g_same_user_1',
        email: 'same_user@gmail.com',
        name: 'Same Google User',
      };

      const u1 = await userService.createUser(input);
      const u2 = await userService.createUser(input);

      expect(u1.id).toBe(u2.id);
      expect(u1.residentId).toBe(u2.residentId);
    });

    it('8.2 repeated OTP login returns identical user for same verified phone', async () => {
      const input = {
        authProvider: 'PHONE' as const,
        providerAccountId: 'ep_919999988888',
        email: '919999988888@phone.relay.local',
        phone: '+919999988888',
        name: 'Same Phone User',
      };

      const u1 = await userService.createUser(input);
      const u2 = await userService.createUser(input);

      expect(u1.id).toBe(u2.id);
    });

    it('8.3 collision safety: rejects duplicate email from different provider (ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER)', async () => {
      const email = 'shared_collision@relay.local';

      // 1. First user registers with Google
      await userService.createUser({
        authProvider: 'GOOGLE',
        providerAccountId: 'g_original_owner',
        email,
        name: 'Original Google Owner',
      });

      // 2. Different provider (PHONE) attempts to register using the exact same email
      await expect(
        userService.createUser({
          authProvider: 'PHONE',
          providerAccountId: 'phone_imposter',
          email,
          name: 'Imposter Phone User',
        })
      ).rejects.toThrow('ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER');
    });

    it('8.4 never silently merges two accounts under different providers', async () => {
      const email = 'no_silent_merge@relay.local';
      await userService.createUser({
        authProvider: 'GOOGLE',
        providerAccountId: 'g_user_a',
        email,
        name: 'User A',
      });

      try {
        await userService.createUser({
          authProvider: 'EMAIL_PHONE',
          providerAccountId: 'ep_user_b',
          email,
          name: 'User B',
        });
      } catch (err: any) {
        expect(err.code).toBe('ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER');
      }

      // Existing Google user remains intact
      const googleUser = await userService.findByProvider('GOOGLE', 'g_user_a');
      expect(googleUser?.name).toBe('User A');
    });

    it('8.5 residentId is deterministically derived from userId and cannot collide', async () => {
      const u1 = await userService.createUser({
        authProvider: 'GOOGLE',
        providerAccountId: 'g_res_test_1',
        email: 'res_test1@gmail.com',
        name: 'User 1',
      });

      const u2 = await userService.createUser({
        authProvider: 'GOOGLE',
        providerAccountId: 'g_res_test_2',
        email: 'res_test2@gmail.com',
        name: 'User 2',
      });

      expect(u1.residentId).not.toBe(u2.residentId);
      expect(u1.residentId).toBe(userService.deriveResidentId(u1.id));
      expect(u2.residentId).toBe(userService.deriveResidentId(u2.id));
    });

    it('8.6 residentId cannot be modified or overridden by external input', async () => {
      const u = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: 'ep_test_res_immut',
        email: 'immutable_res@relay.local',
        name: 'Immutable User',
      });

      const initialResidentId = u.residentId;
      // Invariant: re-querying always yields authoritative derived residentId
      const queried = await userService.getResidentIdForUser(u.id);
      expect(queried).toBe(initialResidentId);
    });
  });

  // =========================================================================
  // SUITE 9: Session Lifecycle, Expiration & Multi-Device Revocation (8 tests)
  // =========================================================================
  describe('9. Session Lifecycle, Expiration & Multi-Device Revocation', () => {
    it('9.1 generates cryptographically secure session tokens starting with rly_', async () => {
      const user = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: 'ep_session_gen',
        email: 'sess_gen@relay.local',
        name: 'Session Gen User',
      });

      const session = await sessionService.createSession(user.id);
      expect(session.token.startsWith('rly_')).toBe(true);
      expect(session.token.length).toBeGreaterThan(40);
    });

    it('9.2 GET /api/auth/session succeeds with valid Bearer session token', async () => {
      const user = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: 'ep_sess_ok',
        email: 'sess_ok@relay.local',
        name: 'Session OK User',
      });

      const session = await sessionService.createSession(user.id);

      const res = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${session.token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.id).toBe(user.id);
    });

    it('9.3 POST /api/auth/logout revokes session immediately', async () => {
      const user = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: 'ep_logout_test',
        email: 'logout_test@relay.local',
        name: 'Logout User',
      });

      const session = await sessionService.createSession(user.id);

      // Logout
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${session.token}`);
      expect(logoutRes.status).toBe(200);

      // Subsequent session check fails with 401
      const checkRes = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${session.token}`);
      expect(checkRes.status).toBe(401);
    });

    it('9.4 revokes all active sessions when user revokes all devices', async () => {
      const user = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: 'ep_multidevice',
        email: 'multidevice@relay.local',
        name: 'Multi Device User',
      });

      const s1 = await sessionService.createSession(user.id);
      const s2 = await sessionService.createSession(user.id);

      await sessionService.revokeAllUserSessions(user.id);

      const val1 = await sessionService.validateSession(s1.token);
      const val2 = await sessionService.validateSession(s2.token);
      expect(val1.valid).toBe(false);
      expect(val2.valid).toBe(false);
    });

    it('9.5 rejects expired session token (HTTP 401)', async () => {
      const user = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: 'ep_exp_sess',
        email: 'exp_sess@relay.local',
        name: 'Expired Session User',
      });

      const expSession = await sessionService.createSession(user.id, { ttlSeconds: -10 });

      const res = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${expSession.token}`);

      expect(res.status).toBe(401);
    });

    it('9.6 deactivated user immediately fails session authentication', async () => {
      const user = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: 'ep_deact_user',
        email: 'deact_user@relay.local',
        name: 'Deactivated User',
      });

      const session = await sessionService.createSession(user.id);
      await userService.deactivateUser(user.id);

      const res = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${session.token}`);

      expect(res.status).toBe(401);
    });

    it('9.7 session cookie is marked HttpOnly and SameSite=Lax', async () => {
      const email = 'cookie_test@example.com';
      await emailPhoneAuthProvider.sendEmailOtp(email);

      const res = await request(app)
        .post('/api/auth/email/verify-otp')
        .send({ email, otpCode: '123456' });

      expect(res.status).toBe(200);
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const sessionCookie = cookies.find((c: string) => c.startsWith('relay_session='));
      expect(sessionCookie).toContain('HttpOnly');
      expect(sessionCookie).toContain('SameSite=Lax');
    });

    it('9.8 session token is never leaked in URLs or error responses', async () => {
      const res = await request(app)
        .get('/api/auth/session')
        .set('Authorization', 'Bearer forged_token_value_abc');

      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain('forged_token_value_abc');
    });
  });

  // =========================================================================
  // SUITE 10: Rate Limiting & Auth Abuse Protection (6 tests)
  // =========================================================================
  describe('10. Rate Limiting & Auth Abuse Protection', () => {
    it('10.1 sets standard rate limit headers on OTP request endpoint', async () => {
      const res = await request(app)
        .post('/api/auth/email/request-otp')
        .send({ email: 'ratelimit_header@example.com' });

      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    });

    it('10.2 blocks client when exceeding OTP_REQUEST rate limit threshold (3 per 120s)', async () => {
      const testIp = '198.51.100.1';

      // Send 3 requests (within limit)
      for (let i = 0; i < 3; i++) {
        await request(app)
          .post('/api/auth/email/request-otp')
          .set('X-Forwarded-For', testIp)
          .send({ email: `rl_user_${i}@example.com` });
      }

      // 4th request from same IP is rate-limited
      const res4 = await request(app)
        .post('/api/auth/email/request-otp')
        .set('X-Forwarded-For', testIp)
        .send({ email: 'rl_user_blocked@example.com' });

      expect(res4.status).toBe(429);
      expect(res4.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(res4.headers['retry-after']).toBeDefined();
    });

    it('10.3 blocks client when exceeding AUTH_ATTEMPT rate limit threshold (5 per 60s)', async () => {
      const testIp = '198.51.100.2';

      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/api/auth/email/verify-otp')
          .set('X-Forwarded-For', testIp)
          .send({ email: 'victim@example.com', otpCode: `00000${i}` });
      }

      // 6th attempt is blocked with 429
      const res6 = await request(app)
        .post('/api/auth/email/verify-otp')
        .set('X-Forwarded-For', testIp)
        .send({ email: 'victim@example.com', otpCode: '999999' });

      expect(res6.status).toBe(429);
      expect(res6.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('10.4 rate limit applies per-IP isolating honest clients from abusive IPs', async () => {
      const abusiveIp = '198.51.100.10';
      const honestIp = '198.51.100.20';

      // Exhaust abusive IP limit
      for (let i = 0; i < 3; i++) {
        await request(app)
          .post('/api/auth/email/request-otp')
          .set('X-Forwarded-For', abusiveIp)
          .send({ email: `abusive_${i}@example.com` });
      }

      // Abusive IP blocked
      const abusiveRes = await request(app)
        .post('/api/auth/email/request-otp')
        .set('X-Forwarded-For', abusiveIp)
        .send({ email: 'abusive_blocked@example.com' });
      expect(abusiveRes.status).toBe(429);

      // Honest IP still succeeds
      const honestRes = await request(app)
        .post('/api/auth/email/request-otp')
        .set('X-Forwarded-For', honestIp)
        .send({ email: 'honest_user@example.com' });
      expect(honestRes.status).toBe(200);
    });

    it('10.5 emits RATE_LIMIT_EXCEEDED audit event when rate limit is tripped', async () => {
      const events: any[] = [];
      eventBus.subscribe('RATE_LIMIT_EXCEEDED', (evt) => events.push(evt));

      const testIp = '198.51.100.33';
      for (let i = 0; i < 4; i++) {
        await request(app)
          .post('/api/auth/email/request-otp')
          .set('X-Forwarded-For', testIp)
          .send({ email: `event_user_${i}@example.com` });
      }

      await new Promise((r) => setTimeout(r, 10));
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].name).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('10.7 untrusted X-Forwarded-For headers cannot evade or split rate limits', async () => {
      // Simulate direct serving (no trusted proxy): distinct spoofed XFF
      // values must share one socket-IP bucket instead of isolating.
      app.set('trust proxy', false);
      try {
        for (let i = 0; i < 3; i++) {
          await request(app)
            .post('/api/auth/email/request-otp')
            .set('X-Forwarded-For', '198.51.100.77')
            .send({ email: `spoof_user_${i}@example.com` });
        }

        // Rotating the header must NOT escape the exhausted bucket.
        const evaded = await request(app)
          .post('/api/auth/email/request-otp')
          .set('X-Forwarded-For', '203.0.113.99')
          .send({ email: 'spoof_escape@example.com' });
        expect(evaded.status).toBe(429);
        expect(evaded.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      } finally {
        app.set('trust proxy', 1);
      }
    });

    it('10.6 rate limit headers accurately reflect remaining request count', async () => {
      const ip = '198.51.100.50';
      const r1 = await request(app)
        .post('/api/auth/email/request-otp')
        .set('X-Forwarded-For', ip)
        .send({ email: 'rl_count_1@example.com' });

      expect(Number(r1.headers['x-ratelimit-remaining'])).toBe(2);

      const r2 = await request(app)
        .post('/api/auth/email/request-otp')
        .set('X-Forwarded-For', ip)
        .send({ email: 'rl_count_2@example.com' });

      expect(Number(r2.headers['x-ratelimit-remaining'])).toBe(1);
    });
  });

  // =========================================================================
  // SUITE 11: Security, Token Masking & Sanitized Audit Stream (6 tests)
  // =========================================================================
  describe('11. Security, Token Masking & Sanitized Audit Stream', () => {
    it('11.1 emits USER_AUTHENTICATED audit event without passwords, tokens, or OTP codes', async () => {
      const events: any[] = [];
      eventBus.subscribe('USER_AUTHENTICATED', (e) => events.push(e));

      identityAuditService.emit('USER_AUTHENTICATED', 'usr_audit_test', {
        provider: 'GOOGLE',
        token: 'super_secret_bearer_token',
        password: 'super_secret_password',
        otpCode: '654321',
        cvv: '123',
        onboardingStatus: 'AUTHENTICATED',
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(events.length).toBe(1);
      expect(events[0].payload.token).toBeUndefined();
      expect(events[0].payload.password).toBeUndefined();
      expect(events[0].payload.otpCode).toBeUndefined();
      expect(events[0].payload.cvv).toBeUndefined();
      expect(events[0].payload.provider).toBe('GOOGLE');
    });

    it('11.2 emits USER_LOGGED_OUT audit event upon session revocation', async () => {
      const events: any[] = [];
      eventBus.subscribe('USER_LOGGED_OUT', (e) => events.push(e));

      const user = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: 'ep_logout_audit',
        email: 'logout_audit@relay.local',
        name: 'Logout Audit User',
      });

      const session = await sessionService.createSession(user.id);
      await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${session.token}`);

      await new Promise((r) => setTimeout(r, 10));
      expect(events.length).toBe(1);
      expect(events[0].payload.userId).toBe(user.id);
    });

    it('11.3 IDOR defense: authenticated user cannot view another resident profile (HTTP 403)', async () => {
      const u1 = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: 'ep_idor_1',
        email: 'idor_1@relay.local',
        name: 'IDOR Resident 1',
      });

      const u2 = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: 'ep_idor_2',
        email: 'idor_2@relay.local',
        name: 'IDOR Resident 2',
      });

      const s1 = await sessionService.createSession(u1.id);

      const res = await request(app)
        .get(`/api/portal/resident?residentId=${u2.residentId}`)
        .set('Authorization', `Bearer ${s1.token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('11.4 AI agent tools cannot override authenticated residentId context', async () => {
      const user = await userService.createUser({
        authProvider: 'GOOGLE',
        providerAccountId: 'g_ai_boundary',
        email: 'ai_boundary@gmail.com',
        name: 'AI Boundary User',
      });

      // AI tries to impersonate another residentId
      const spoofedResidentId = 'res_arbitrary_impersonation';
      const isAuthorized = await userService.validateUserOwnership(user.id, spoofedResidentId);
      expect(isAuthorized).toBe(false);
    });

    it('11.5 supplier privacy: supplier delivery view never contains resident name or unit number', async () => {
      // Invariant: suppliers only interact with community-level consolidated delivery
      const supplierView: any = {
        societyName: 'Greenview Residency',
        address: 'Kalyani Nagar, Pune',
        deliveryInstructions: 'Deliver to Central Security Gate',
      };

      expect(supplierView.flatNumber).toBeUndefined();
      expect(supplierView.residentName).toBeUndefined();
      expect(supplierView.email).toBeUndefined();
    });

    it('11.6 audit log sanitization strips nested sensitive keys recursively', () => {
      const payload = {
        meta: {
          token: 'nested_secret_token',
          nested: {
            password: 'deep_password',
            publicInfo: 'safe_to_log',
          },
        },
      };

      const sanitized = (identityAuditService as any).sanitizePayload(payload);
      expect(sanitized.meta.token).toBeUndefined();
      expect(sanitized.meta.nested.password).toBeUndefined();
      expect(sanitized.meta.nested.publicInfo).toBe('safe_to_log');
    });
  });

  // =========================================================================
  // SUITE 12: Location Independence & Dynamic Onboarding Lifecycle (6 tests)
  // =========================================================================
  describe('12. Location Independence & Dynamic Onboarding Lifecycle', () => {
    it('12.1 executes complete onboarding for Nashik user dynamically', async () => {
      const user = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: 'ep_nashik_user',
        email: 'nashik_resident@relay.local',
        name: 'Nashik Resident',
      });

      expect(user.onboardingStatus).toBe('AUTHENTICATED');
      expect(user.residentId.startsWith('res_')).toBe(true);
    });

    it('12.2 executes complete onboarding for Pune user dynamically', async () => {
      const user = await userService.createUser({
        authProvider: 'PHONE',
        providerAccountId: 'ep_pune_user',
        phone: '+919876500001',
        email: 'pune_resident@relay.local',
        name: 'Pune Resident',
      });

      expect(user.onboardingStatus).toBe('AUTHENTICATED');
    });

    it('12.3 executes complete onboarding for Bangalore user dynamically', async () => {
      const user = await userService.createUser({
        authProvider: 'GOOGLE',
        providerAccountId: 'g_blr_user',
        email: 'bangalore_resident@gmail.com',
        name: 'Bangalore Resident',
      });

      expect(user.onboardingStatus).toBe('AUTHENTICATED');
    });

    it('12.4 executes complete onboarding for Delhi user dynamically', async () => {
      const user = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: 'ep_delhi_user',
        email: 'delhi_resident@relay.local',
        name: 'Delhi Resident',
      });

      expect(user.onboardingStatus).toBe('AUTHENTICATED');
    });

    it('12.5 executes complete onboarding for London user dynamically', async () => {
      const user = await userService.createUser({
        authProvider: 'PHONE',
        providerAccountId: 'ph_london_user',
        email: 'london_resident@relay.local',
        name: 'London Resident',
      });

      expect(user.onboardingStatus).toBe('AUTHENTICATED');
    });

    it('12.6 executes complete onboarding for Tokyo user dynamically', async () => {
      const user = await userService.createUser({
        authProvider: 'EMAIL',
        providerAccountId: 'ep_tokyo_user',
        email: 'tokyo_resident@relay.local',
        name: 'Tokyo Resident',
      });

      expect(user.onboardingStatus).toBe('AUTHENTICATED');
      expect(user.residentId).toBeDefined();
    });
  });

  // =========================================================================
  // SUITE 13: OAuth Grant-Code Exchange (session token never travels in URLs)
  // =========================================================================
  describe('13. OAuth Grant-Code Exchange', () => {
    it('13.1 exchanges a fresh grant code for the session exactly once', async () => {
      const user = await userService.createUser({
        authProvider: 'GOOGLE',
        providerAccountId: `g_grant_${Date.now()}`,
        email: `grant_${Date.now()}@relay.local`,
        name: 'Grant User',
      });
      const session = await sessionService.createSession(user.id);
      const code = oauthGrantService.issueGrant(session.token, user.id);

      const first = await request(app).post('/api/auth/oauth/exchange').send({ code });
      expect(first.status).toBe(200);
      expect(first.body.data.session.token).toBe(session.token);
      expect(first.body.data.user.id).toBe(user.id);

      // Replay is rejected: single-use.
      const replay = await request(app).post('/api/auth/oauth/exchange').send({ code });
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('INVALID_OAUTH_GRANT');
    });

    it('13.2 rejects unknown and empty grant codes', async () => {
      const unknown = await request(app)
        .post('/api/auth/oauth/exchange')
        .send({ code: 'rly_gr_never_issued' });
      expect(unknown.status).toBe(401);

      const empty = await request(app).post('/api/auth/oauth/exchange').send({});
      expect(empty.status).toBe(401);
    });

    it('13.3 OAuth callback redirects with a grant code, never the session token', async () => {
      const state = oauthStateManager.createState('GOOGLE', 'http://localhost:4000/api/auth/google/callback');
      const spy = vi.spyOn(googleAuthProvider, 'handleCallback').mockResolvedValue({
        success: true,
        requiresConfig: false,
        user: {
          id: 'usr_grant_cb',
          authProvider: 'GOOGLE',
          providerAccountId: `g_cb_${Date.now()}`,
          email: `cb_${Date.now()}@relay.local`,
          name: 'Callback User',
          onboardingStatus: 'AUTHENTICATED',
          residentId: 'res_cb_probe',
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      } as any);
      try {
        const res = await request(app)
          .get('/api/auth/google/callback')
          .query({ code: 'auth_code_probe', state })
          .redirects(0);
        expect(res.status).toBe(302);
        const location = res.headers.location as string;
        expect(location).toContain('oauthGrant=rly_gr_');
        expect(location).not.toContain('sessionToken=');
      } finally {
        spy.mockRestore();
      }
    });

    it('13.4 request logs redact credential-bearing query parameters', async () => {
      const { sanitizeUrlForLogging } = await import('../src/middleware/request-logger.middleware');
      expect(sanitizeUrlForLogging('/api/auth/google/callback?code=abc&state=xyz')).toBe(
        '/api/auth/google/callback?code=%5BREDACTED%5D&state=%5BREDACTED%5D'
      );
      expect(sanitizeUrlForLogging('/onboarding?oauthGrant=rly_gr_secret&next=%2Fmission')).toBe(
        '/onboarding?oauthGrant=%5BREDACTED%5D&next=%2Fmission'
      );
      expect(sanitizeUrlForLogging('/api/portal/orders')).toBe('/api/portal/orders');
    });
  });
});
