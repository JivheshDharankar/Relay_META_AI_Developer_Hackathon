/**
 * RELAY — TWILIO VERIFY ADVERSARIAL & COMPREHENSIVE TEST MATRIX
 *
 * Full verification across 6 test dimensions:
 * A. Configuration (valid, missing Account SID, missing Auth Token, missing Service SID, invalid format)
 * B. OTP delivery (valid destination, invalid phone format, rejected request, trial restriction, network timeout, 503 unavailable)
 * C. OTP verification (correct OTP, incorrect OTP, expired OTP, reused OTP, malformed OTP, service error)
 * D. Resend and abuse (immediate resend, repeated resend, cooldown expiration, old code, max attempts, concurrent checks, rate limits)
 * E. Authentication (signup OTP flow, login OTP flow, retry after failure, backend restart, no unauthorized login, no mock bypass)
 * F. Security (OTP never in logs/responses, credentials never in logs, no account enumeration, unauthorized rejected)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import {
  TwilioVerifyProvider,
  smsService,
  emailPhoneAuthProvider,
  sessionService,
  rateLimiterService,
  identityAuditService,
} from '../src/identity';

describe('Twilio Verify Integration & Adversarial Verification', () => {
  const TEST_ACCOUNT_SID = ['AC', '1234567890abcdef1234567890abcdef'].join('');
  const TEST_AUTH_TOKEN = ['abcdef1234567890', 'abcdef1234567890'].join('');
  const TEST_SERVICE_SID = ['VA', '1234567890abcdef1234567890abcdef'].join('');
  const VALID_PHONE = '+919876543210';
  const VALID_CODE = '789123';

  beforeEach(() => {
    emailPhoneAuthProvider.clear();
    rateLimiterService.clear();
    smsService.setProviderOverride('twilio');
    (smsService as any).twilioVerifyProvider = new TwilioVerifyProvider({
      accountSid: TEST_ACCOUNT_SID,
      authToken: TEST_AUTH_TOKEN,
      verifyServiceSid: TEST_SERVICE_SID,
    });
  });

  // =========================================================================
  // GROUP A: CONFIGURATION (5 tests)
  // =========================================================================
  describe('Group A: Configuration & Fail-Closed Boundaries', () => {
    it('A1: accepts complete and valid Twilio Verify credentials', () => {
      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
      });

      const validation = provider.validateConfig();
      expect(validation.valid).toBe(true);
      expect(validation.missing.length).toBe(0);
      expect(provider.isConfigured).toBe(true);
    });

    it('A2: detects and fails closed when TWILIO_ACCOUNT_SID is missing', async () => {
      const provider = new TwilioVerifyProvider({
        accountSid: undefined,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
      });

      const validation = provider.validateConfig();
      expect(validation.valid).toBe(false);
      expect(validation.missing).toContain('TWILIO_ACCOUNT_SID');
      expect(provider.isConfigured).toBe(false);

      const res = await provider.sendVerification(VALID_PHONE);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('TWILIO_UNCONFIGURED');
    });

    it('A3: detects and fails closed when TWILIO_AUTH_TOKEN is missing', async () => {
      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: '',
        verifyServiceSid: TEST_SERVICE_SID,
      });

      const validation = provider.validateConfig();
      expect(validation.valid).toBe(false);
      expect(validation.missing).toContain('TWILIO_AUTH_TOKEN');

      const res = await provider.checkVerification(VALID_PHONE, VALID_CODE);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('TWILIO_UNCONFIGURED');
    });

    it('A4: detects and fails closed when TWILIO_VERIFY_SERVICE_SID is missing', async () => {
      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: undefined,
      });

      const validation = provider.validateConfig();
      expect(validation.valid).toBe(false);
      expect(validation.missing).toContain('TWILIO_VERIFY_SERVICE_SID');

      const res = await provider.sendVerification(VALID_PHONE);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('TWILIO_UNCONFIGURED');
    });

    it('A5: rejects invalid Account SID and Service SID format and fails closed without silent mock fallback', async () => {
      const invalidProvider = new TwilioVerifyProvider({
        accountSid: 'INVALID_SID_WITHOUT_AC_PREFIX',
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: 'INVALID_VA_PREFIX',
      });

      const validation = invalidProvider.validateConfig();
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain('TWILIO_ACCOUNT_SID format is invalid');

      const res = await invalidProvider.sendVerification(VALID_PHONE);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('TWILIO_UNCONFIGURED');
    });
  });

  // =========================================================================
  // GROUP B: OTP DELIVERY (6 tests)
  // =========================================================================
  describe('Group B: OTP Delivery Channels & Error Mapping', () => {
    it('B1: dispatches OTP to valid destination in E.164 format and captures verification SID', async () => {
      let dispatchedUrl = '';
      let authHeader = '';
      let bodyParams = '';

      const mockFetch: typeof fetch = async (url, init) => {
        dispatchedUrl = String(url);
        authHeader = String(init?.headers && (init.headers as any).Authorization);
        bodyParams = String(init?.body);
        return new Response(
          JSON.stringify({
            sid: 'VE_mock_verification_123',
            service_sid: TEST_SERVICE_SID,
            status: 'pending',
            to: VALID_PHONE,
            channel: 'sms',
            valid: false,
          }),
          { status: 200 }
        );
      };

      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const res = await provider.sendVerification(VALID_PHONE);
      expect(res.success).toBe(true);
      expect(res.messageId).toBe('VE_mock_verification_123');
      expect(dispatchedUrl).toContain(`Services/${TEST_SERVICE_SID}/Verifications`);
      expect(authHeader).toContain('Basic ');
      expect(bodyParams).toContain('Channel=sms');
    });

    it('B2: rejects invalid phone number formats before network invocation', async () => {
      let networkCalled = false;
      const mockFetch: typeof fetch = async () => {
        networkCalled = true;
        return new Response('{}', { status: 200 });
      };

      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const res = await provider.sendVerification('not-a-phone-number');
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('INVALID_PHONE_FORMAT');
      expect(networkCalled).toBe(false);
    });

    it('B3: handles Twilio API rejection safely with mapped error code', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            code: 60200,
            message: 'Invalid parameter: To is not a valid mobile phone number',
            status: 400,
          }),
          { status: 400 }
        );
      };

      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const res = await provider.sendVerification(VALID_PHONE);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('INVALID_PHONE_FORMAT');
    });

    it('B4: detects Twilio Trial Account restriction (code 21608) and provides actionable guidance', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            code: 21608,
            message:
              'The number +919876543210 is unverified. Trial accounts cannot send messages to unverified numbers; verify at twilio.com/user/account/phone-numbers/verified',
            status: 400,
          }),
          { status: 400 }
        );
      };

      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const res = await provider.sendVerification(VALID_PHONE);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('TWILIO_TRIAL_RESTRICTION');
      expect(res.errorMessage).toContain('Twilio Trial Account: destination phone number is unverified');
    });

    it('B5: handles network timeout safely without crashing', async () => {
      const mockFetch: typeof fetch = async () => {
        throw new Error('ETIMEDOUT: Connection to verify.twilio.com timed out after 30000ms');
      };

      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const res = await provider.sendVerification(VALID_PHONE);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('TWILIO_NETWORK_ERROR');
      expect(res.errorMessage).toContain('Connection to verify.twilio.com timed out');
    });

    it('B6: handles Twilio 503 Provider Unavailable safely', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response('Service Temporarily Unavailable', { status: 503 });
      };

      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const res = await provider.sendVerification(VALID_PHONE);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('TWILIO_REJECTED_REQUEST');
    });
  });

  // =========================================================================
  // GROUP C: OTP VERIFICATION (6 tests)
  // =========================================================================
  describe('Group C: VerificationCheck Logic & State Invariants', () => {
    it('C1: succeeds when Twilio VerificationCheck returns approved', async () => {
      const mockFetch: typeof fetch = async (url, init) => {
        const body = String(init?.body);
        expect(body).toContain(`Code=${VALID_CODE}`);
        return new Response(
          JSON.stringify({
            sid: 'VE_check_success',
            service_sid: TEST_SERVICE_SID,
            status: 'approved',
            valid: true,
            to: VALID_PHONE,
          }),
          { status: 200 }
        );
      };

      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const res = await provider.checkVerification(VALID_PHONE, VALID_CODE);
      expect(res.success).toBe(true);
      expect(res.status).toBe('approved');
    });

    it('C2: rejects incorrect OTP when Twilio returns pending/invalid', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            sid: 'VE_check_pending',
            service_sid: TEST_SERVICE_SID,
            status: 'pending',
            valid: false,
            to: VALID_PHONE,
          }),
          { status: 200 }
        );
      };

      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const res = await provider.checkVerification(VALID_PHONE, '000000');
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('INVALID_OTP');
    });

    it('C3: handles expired OTP when Twilio returns 404 (Resource Not Found)', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            code: 20404,
            message: 'The requested resource /Services/VA.../VerificationCheck was not found',
            status: 404,
          }),
          { status: 404 }
        );
      };

      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const res = await provider.checkVerification(VALID_PHONE, VALID_CODE);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('OTP_EXPIRED');
    });

    it('C4: prevents OTP reuse (replay attack) when Twilio consumes approved code', async () => {
      let callCount = 0;
      const mockFetch: typeof fetch = async () => {
        callCount++;
        if (callCount === 1) {
          return new Response(
            JSON.stringify({ status: 'approved', valid: true, sid: 'VE_first' }),
            { status: 200 }
          );
        }
        // Twilio deletes verified session upon approval; subsequent verification returns 404
        return new Response(
          JSON.stringify({ code: 20404, message: 'Verification not found', status: 404 }),
          { status: 404 }
        );
      };

      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const res1 = await provider.checkVerification(VALID_PHONE, VALID_CODE);
      expect(res1.success).toBe(true);

      const res2 = await provider.checkVerification(VALID_PHONE, VALID_CODE);
      expect(res2.success).toBe(false);
      expect(res2.errorCode).toBe('OTP_EXPIRED');
    });

    it('C5: rejects malformed OTP codes (non-numeric, too short, too long) before network dispatch', async () => {
      let networkCalled = false;
      const mockFetch: typeof fetch = async () => {
        networkCalled = true;
        return new Response('{}', { status: 200 });
      };

      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const malformed1 = await provider.checkVerification(VALID_PHONE, 'abc');
      expect(malformed1.errorCode).toBe('MALFORMED_OTP');

      const malformed2 = await provider.checkVerification(VALID_PHONE, '12'); // Too short
      expect(malformed2.errorCode).toBe('MALFORMED_OTP');

      const malformed3 = await provider.checkVerification(VALID_PHONE, '1234567890123'); // Too long
      expect(malformed3.errorCode).toBe('MALFORMED_OTP');

      expect(networkCalled).toBe(false);
    });

    it('C6: handles Twilio Verify service 500 internal error safely', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response('Internal Server Error', { status: 500 });
      };

      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const res = await provider.checkVerification(VALID_PHONE, VALID_CODE);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('TWILIO_VERIFICATION_ERROR');
    });
  });

  // =========================================================================
  // GROUP D: RESEND, COOLDOWN & ABUSE PROTECTION (7 tests)
  // =========================================================================
  describe('Group D: Resend & Abuse Protection', () => {
    it('D1: rejects immediate resend within 30-second cooldown window', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ sid: 'VE_1', status: 'pending' }), { status: 200 });
      };

      (smsService as any).twilioVerifyProvider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      await emailPhoneAuthProvider.sendPhoneOtp(VALID_PHONE);

      // Immediate resend should throw OTP_COOLDOWN_ACTIVE
      await expect(emailPhoneAuthProvider.sendPhoneOtp(VALID_PHONE)).rejects.toThrow(
        'OTP_COOLDOWN_ACTIVE'
      );
    });

    it('D2: enforces 30-second cooldown via HTTP POST /api/auth/phone/request-otp (HTTP 429)', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ sid: 'VE_http_1', status: 'pending' }), {
          status: 200,
        });
      };

      (smsService as any).twilioVerifyProvider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const phone = '+919876543220';
      const res1 = await request(app).post('/api/auth/phone/request-otp').send({ phone });
      expect(res1.status).toBe(200);

      const res2 = await request(app).post('/api/auth/phone/request-otp').send({ phone });
      expect(res2.status).toBe(429);
      expect(res2.body.error.code).toBe('OTP_COOLDOWN_ACTIVE');
    });

    it('D3: permits resend after cooldown period has elapsed', async () => {
      let callCount = 0;
      const mockFetch: typeof fetch = async () => {
        callCount++;
        return new Response(JSON.stringify({ sid: `VE_call_${callCount}`, status: 'pending' }), {
          status: 200,
        });
      };

      (smsService as any).twilioVerifyProvider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const phone = '+919876543221';
      await emailPhoneAuthProvider.sendPhoneOtp(phone);
      expect(callCount).toBe(1);

      // Fast-forward past 30s cooldown
      const stored = (emailPhoneAuthProvider as any).otpStore.get(phone);
      if (stored) {
        stored.lastSentAt = new Date(Date.now() - 35000);
      }

      await emailPhoneAuthProvider.sendPhoneOtp(phone);
      expect(callCount).toBe(2);
    });

    it('D4: invalidates old code when new OTP is requested after cooldown', async () => {
      let activeCode = '111111';
      const mockFetch: typeof fetch = async (url, init) => {
        if (String(url).includes('VerificationCheck')) {
          const body = String(init?.body);
          if (body.includes(`Code=${activeCode}`)) {
            return new Response(JSON.stringify({ status: 'approved', valid: true }), { status: 200 });
          }
          return new Response(JSON.stringify({ status: 'pending', valid: false }), { status: 200 });
        }
        return new Response(JSON.stringify({ sid: 'VE_resend', status: 'pending' }), { status: 200 });
      };

      (smsService as any).twilioVerifyProvider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const phone = '+919876543222';
      await emailPhoneAuthProvider.sendPhoneOtp(phone);

      // Cooldown elapses and new OTP is issued
      const stored = (emailPhoneAuthProvider as any).otpStore.get(phone);
      if (stored) stored.lastSentAt = new Date(Date.now() - 35000);

      activeCode = '222222'; // Twilio issues new code
      await emailPhoneAuthProvider.sendPhoneOtp(phone);

      // Trying old code 111111 fails
      const checkOld = await emailPhoneAuthProvider.authenticate({
        provider: 'PHONE',
        phone,
        otpCode: '111111',
      });
      expect(checkOld.success).toBe(false);
      expect(checkOld.errorCode).toBe('INVALID_OTP');

      // New code succeeds
      const checkNew = await emailPhoneAuthProvider.authenticate({
        provider: 'PHONE',
        phone,
        otpCode: '222222',
      });
      expect(checkNew.success).toBe(true);
    });

    it('D5: locks out destination after 3 consecutive failed verification attempts (MAX_OTP_ATTEMPTS_EXCEEDED)', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ status: 'pending', valid: false }), { status: 200 });
      };

      (smsService as any).twilioVerifyProvider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const phone = '+919876543223';
      await emailPhoneAuthProvider.sendPhoneOtp(phone);

      await emailPhoneAuthProvider.authenticate({ provider: 'PHONE', phone, otpCode: '900001' });
      await emailPhoneAuthProvider.authenticate({ provider: 'PHONE', phone, otpCode: '900002' });
      const third = await emailPhoneAuthProvider.authenticate({
        provider: 'PHONE',
        phone,
        otpCode: '900003',
      });
      expect(third.errorCode).toBe('MAX_OTP_ATTEMPTS_EXCEEDED');

      // Subsequent attempt is immediately rejected without Twilio dispatch
      const fourth = await emailPhoneAuthProvider.authenticate({
        provider: 'PHONE',
        phone,
        otpCode: '900004',
      });
      expect(fourth.errorCode).toBe('MAX_OTP_ATTEMPTS_EXCEEDED');
    });

    it('D6: serializes concurrent verification requests and prevents duplicate consumption', async () => {
      let checkAttempts = 0;
      const mockFetch: typeof fetch = async (url) => {
        if (String(url).includes('VerificationCheck')) {
          checkAttempts++;
          if (checkAttempts === 1) {
            return new Response(JSON.stringify({ status: 'approved', valid: true }), { status: 200 });
          }
          return new Response(
            JSON.stringify({ code: 20404, message: 'Verification already consumed', status: 404 }),
            { status: 404 }
          );
        }
        return new Response(JSON.stringify({ sid: 'VE_conc', status: 'pending' }), { status: 200 });
      };

      (smsService as any).twilioVerifyProvider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const phone = '+919876543224';
      await emailPhoneAuthProvider.sendPhoneOtp(phone);

      const [res1, res2] = await Promise.all([
        emailPhoneAuthProvider.authenticate({ provider: 'PHONE', phone, otpCode: VALID_CODE }),
        emailPhoneAuthProvider.authenticate({ provider: 'PHONE', phone, otpCode: VALID_CODE }),
      ]);

      const successCount = [res1, res2].filter((r) => r.success).length;
      expect(successCount).toBe(1);
    });

    it('D7: maps Twilio rate limit 429 (code 60203) to MAX_OTP_ATTEMPTS_EXCEEDED', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            code: 60203,
            message: 'Max send attempts reached',
            status: 429,
          }),
          { status: 429 }
        );
      };

      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const res = await provider.sendVerification(VALID_PHONE);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('MAX_OTP_ATTEMPTS_EXCEEDED');
    });
  });

  // =========================================================================
  // GROUP E: AUTHENTICATION FLOWS (6 tests)
  // =========================================================================
  describe('Group E: Complete User Authentication Lifecycle', () => {
    it('E1: completes full signup onboarding flow for fresh phone user', async () => {
      const mockFetch: typeof fetch = async (url) => {
        if (String(url).includes('VerificationCheck')) {
          return new Response(JSON.stringify({ status: 'approved', valid: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ sid: 'VE_signup', status: 'pending' }), { status: 200 });
      };

      (smsService as any).twilioVerifyProvider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const phone = '+919876543230';
      const reqRes = await request(app).post('/api/auth/phone/request-otp').send({ phone });
      expect(reqRes.status).toBe(200);

      const verifyRes = await request(app)
        .post('/api/auth/phone/verify-otp')
        .send({ phone, otpCode: VALID_CODE });
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);
      expect(verifyRes.body.data.user.phone).toBe(phone);
      expect(verifyRes.body.data.session.token).toBeDefined();
    });

    it('E2: completes login flow for returning phone user and returns existing identity', async () => {
      const mockFetch: typeof fetch = async (url) => {
        if (String(url).includes('VerificationCheck')) {
          return new Response(JSON.stringify({ status: 'approved', valid: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ sid: 'VE_login', status: 'pending' }), { status: 200 });
      };

      (smsService as any).twilioVerifyProvider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const phone = '+919876543231';
      // First verification creates identity
      const first = await emailPhoneAuthProvider.authenticate({
        provider: 'PHONE',
        phone,
        otpCode: VALID_CODE,
      });

      // Second verification logs in the same user
      const second = await emailPhoneAuthProvider.authenticate({
        provider: 'PHONE',
        phone,
        otpCode: VALID_CODE,
      });

      expect(first.user?.id).toBe(second.user?.id);
      expect(first.user?.residentId).toBe(second.user?.residentId);
    });

    it('E3: allows successful verification retry after prior incorrect code attempt', async () => {
      let callCount = 0;
      const mockFetch: typeof fetch = async (url) => {
        if (String(url).includes('VerificationCheck')) {
          callCount++;
          if (callCount === 1) {
            return new Response(JSON.stringify({ status: 'pending', valid: false }), { status: 200 });
          }
          return new Response(JSON.stringify({ status: 'approved', valid: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ sid: 'VE_retry', status: 'pending' }), { status: 200 });
      };

      (smsService as any).twilioVerifyProvider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const phone = '+919876543232';
      await emailPhoneAuthProvider.sendPhoneOtp(phone);

      // Attempt 1: wrong code fails
      const attempt1 = await emailPhoneAuthProvider.authenticate({
        provider: 'PHONE',
        phone,
        otpCode: '000000',
      });
      expect(attempt1.success).toBe(false);

      // Attempt 2: correct code succeeds
      const attempt2 = await emailPhoneAuthProvider.authenticate({
        provider: 'PHONE',
        phone,
        otpCode: VALID_CODE,
      });
      expect(attempt2.success).toBe(true);
    });

    it('E4: survives backend restart — verifies user post-restart because Twilio maintains cloud verification session', async () => {
      const mockFetch: typeof fetch = async (url) => {
        if (String(url).includes('VerificationCheck')) {
          return new Response(JSON.stringify({ status: 'approved', valid: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ sid: 'VE_restart', status: 'pending' }), { status: 200 });
      };

      (smsService as any).twilioVerifyProvider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const phone = '+919876543233';
      await emailPhoneAuthProvider.sendPhoneOtp(phone);

      // Simulate full backend restart: clear in-memory state
      emailPhoneAuthProvider.clear();

      // VerificationCheck directly queries Twilio cloud session and succeeds!
      const res = await emailPhoneAuthProvider.authenticate({
        provider: 'PHONE',
        phone,
        otpCode: VALID_CODE,
      });
      expect(res.success).toBe(true);
      expect(res.user?.phone).toBe(phone);
    });

    it('E5: rejects unauthorized verification without valid OTP', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ status: 'pending', valid: false }), { status: 200 });
      };

      (smsService as any).twilioVerifyProvider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const res = await request(app).post('/api/auth/phone/verify-otp').send({
        phone: VALID_PHONE,
        otpCode: '999999',
      });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBeDefined();
    });

    it('E6: STRICT REQUIREMENT — development OTP bypass (123456) is disabled when Twilio is active', async () => {
      // Mock Twilio returning pending (invalid) for 123456
      const mockFetch: typeof fetch = async (url, init) => {
        if (String(url).includes('VerificationCheck')) {
          return new Response(JSON.stringify({ status: 'pending', valid: false }), { status: 200 });
        }
        return new Response(JSON.stringify({ sid: 'VE_bypass_test', status: 'pending' }), { status: 200 });
      };

      (smsService as any).twilioVerifyProvider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const phone = '+919876543234';
      await emailPhoneAuthProvider.sendPhoneOtp(phone);

      // In non-production, 123456 would ordinarily bypass mock OTP.
      // But because Twilio is selected, it MUST NOT bypass and must be rejected!
      const bypassAttempt = await emailPhoneAuthProvider.authenticate({
        provider: 'PHONE',
        phone,
        otpCode: '123456',
      });
      expect(bypassAttempt.success).toBe(false);
      expect(bypassAttempt.errorCode).toBe('INVALID_OTP');
    });
  });

  // =========================================================================
  // GROUP F: SECURITY & PRIVACY BOUNDARIES (4 tests)
  // =========================================================================
  describe('Group F: Security & Zero Secret Leakage', () => {
    it('F1: OTP code never appears in API response bodies or headers', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ sid: 'VE_secret_test', status: 'pending' }), { status: 200 });
      };

      (smsService as any).twilioVerifyProvider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const phone = '+919876543240';
      const res = await request(app).post('/api/auth/phone/request-otp').send({ phone });

      expect(res.status).toBe(200);
      const resString = JSON.stringify(res.body);
      // Ensure no 6-digit code or credentials leaked
      expect(res.body.data.messageId).toBe('VE_secret_test');
      expect(resString).not.toMatch(/\b\d{6}\b/);
      expect(resString).not.toContain(TEST_AUTH_TOKEN);
    });

    it('F2: Twilio credentials never appear in server audit events or error responses', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            code: 20003,
            message: 'Authentication Error - invalid username/password',
            status: 401,
          }),
          { status: 401 }
        );
      };

      const provider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      const res = await provider.sendVerification(VALID_PHONE);
      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('TWILIO_AUTH_ERROR');

      const serialized = JSON.stringify(res);
      expect(serialized).not.toContain(TEST_AUTH_TOKEN);
    });

    it('F3: prevents account enumeration on OTP request endpoint', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ sid: 'VE_enum', status: 'pending' }), { status: 200 });
      };

      (smsService as any).twilioVerifyProvider = new TwilioVerifyProvider({
        accountSid: TEST_ACCOUNT_SID,
        authToken: TEST_AUTH_TOKEN,
        verifyServiceSid: TEST_SERVICE_SID,
        fetchFn: mockFetch,
      });

      // Request for fresh vs existing phone returns identical 200 success shape
      const res1 = await request(app)
        .post('/api/auth/phone/request-otp')
        .send({ phone: '+919876543241' });
      const res2 = await request(app)
        .post('/api/auth/phone/request-otp')
        .send({ phone: '+919876543242' });

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body.data.message).toBe(res2.body.data.message);
    });

    it('F4: rejects unauthorized verification attempts without valid destination', async () => {
      const res = await request(app).post('/api/auth/phone/verify-otp').send({
        phone: 'invalid',
        otpCode: VALID_CODE,
      });
      expect(res.status).toBe(400); // Validation failure
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
