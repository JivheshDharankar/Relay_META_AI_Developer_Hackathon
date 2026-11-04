import { randomInt, randomUUID } from 'crypto';
import { AuthCredentials, AuthResult, ProviderMetadata, ProviderStatus } from '../types';
import { AuthProvider } from './AuthProvider';
import { emailService } from './email/EmailService';
import { smsService } from './sms/SmsService';

interface StoredOtp {
  destination: string;
  code: string;
  expiresAt: Date;
  lastSentAt: Date;
  attempts: number;
}

export class EmailPhoneAuthProvider implements AuthProvider {
  public readonly providerName = 'EMAIL_PHONE';
  public readonly isConfigured = true; // Always natively configured in Relay

  public get status(): ProviderStatus {
    return 'CONFIGURED';
  }

  private otpStore = new Map<string, StoredOtp>();
  private readonly cooldownMs = 30 * 1000; // 30 seconds resend cooldown
  private readonly ttlMs = 5 * 60 * 1000; // 5 minutes validity
  private readonly maxAttempts = 3;

  public getMetadata(): ProviderMetadata {
    return {
      id: 'EMAIL_PHONE',
      name: 'Email & Phone OTP',
      type: 'OTP',
      status: this.status,
      isAvailable: true,
      requiresConfig: false,
    };
  }

  /**
   * Generates and dispatches a cryptographically secure 6-digit OTP.
   * Guarantees resend cooldown and zero OTP leakage in logs.
   */
  public async sendOtp(destination: string): Promise<{ success: boolean; messageId: string; cooldownSeconds: number }> {
    const trimmed = destination.trim().toLowerCase();
    if (!trimmed) {
      throw new Error('Destination email or phone is required');
    }

    const now = Date.now();
    const existing = this.otpStore.get(trimmed);

    // Enforce resend cooldown
    if (existing && now - existing.lastSentAt.getTime() < this.cooldownMs) {
      const remainingSeconds = Math.ceil((this.cooldownMs - (now - existing.lastSentAt.getTime())) / 1000);
      throw new Error(`OTP_COOLDOWN_ACTIVE: Please wait ${remainingSeconds} seconds before requesting another code`);
    }

    // Cryptographically secure 6-digit numeric OTP
    const code = randomInt(100000, 1000000).toString();
    const expiresAt = new Date(now + this.ttlMs);

    this.otpStore.set(trimmed, {
      destination: trimmed,
      code,
      expiresAt,
      lastSentAt: new Date(now),
      attempts: 0,
    });

    let messageId = `otp_msg_${randomUUID().slice(0, 8)}`;

    // Dispatch via real provider channels
    if (trimmed.includes('@')) {
      const emailRes = await emailService.sendOtpEmail(trimmed, code);
      if (emailRes.messageId) messageId = emailRes.messageId;
    } else {
      if (smsService.isTwilioSelected) {
        // STRICT REQUIREMENT: Fail closed if Twilio Verify config is missing or invalid.
        // Never silently fall back to mock.
        const configCheck = smsService.verifyProvider.validateConfig();
        if (!configCheck.valid) {
          throw new Error(`TWILIO_CONFIG_ERROR: ${configCheck.error}`);
        }
        const verifyRes = await smsService.verifyProvider.sendVerification(trimmed);
        if (!verifyRes.success) {
          const err = new Error(verifyRes.errorMessage || 'Twilio Verify dispatch failed');
          (err as any).code = verifyRes.errorCode || 'TWILIO_DISPATCH_FAILED';
          throw err;
        }
        messageId = verifyRes.messageId;
      } else {
        const smsRes = await smsService.sendOtp(trimmed, code);
        if (smsRes.messageId) messageId = smsRes.messageId;
      }
    }

    return {
      success: true,
      messageId,
      cooldownSeconds: 30,
    };
  }

  /**
   * Dedicated Email OTP request.
   */
  public async sendEmailOtp(email: string): Promise<{ success: boolean; messageId: string; cooldownSeconds: number }> {
    return this.sendOtp(email);
  }

  /**
   * Dedicated Phone OTP request.
   */
  public async sendPhoneOtp(phone: string): Promise<{ success: boolean; messageId: string; cooldownSeconds: number }> {
    return this.sendOtp(phone);
  }

  /**
   * Verifies OTP and returns authoritative user result.
   */
  public async authenticate(credentials: AuthCredentials): Promise<AuthResult> {
    const destination = (credentials.email || credentials.phone || '').trim().toLowerCase();
    if (!destination) {
      return {
        success: false,
        errorCode: 'MISSING_DESTINATION',
        errorMessage: 'Email or phone number is required for authentication',
      };
    }

    if (!credentials.otpCode) {
      return {
        success: false,
        errorCode: 'MISSING_OTP',
        errorMessage: 'OTP code is required for email/phone verification',
      };
    }

    const isPhone = !destination.includes('@');

    // Branch A: Twilio Verify Path for Phone Authentication
    if (isPhone && smsService.isTwilioSelected) {
      // 1. Fail closed on missing/invalid Twilio configuration
      const configCheck = smsService.verifyProvider.validateConfig();
      if (!configCheck.valid) {
        return {
          success: false,
          errorCode: 'TWILIO_UNCONFIGURED',
          errorMessage: configCheck.error || 'Twilio Verify is not properly configured.',
        };
      }

      // 2. Local abuse / max attempts check
      const stored = this.otpStore.get(destination);
      if (stored && stored.attempts >= this.maxAttempts) {
        return {
          success: false,
          errorCode: 'MAX_OTP_ATTEMPTS_EXCEEDED',
          errorMessage: 'Too many incorrect attempts. This OTP is invalidated.',
        };
      }

      // 3. STRICT REQUIREMENT: Development OTP '123456' bypass is STRICTLY DISABLED when Twilio is active.
      // Every code must be authoritatively verified by Twilio VerificationCheck.
      const verifyRes = await smsService.verifyProvider.checkVerification(destination, credentials.otpCode);
      if (!verifyRes.success) {
        if (stored) {
          stored.attempts += 1;
          if (stored.attempts >= this.maxAttempts) {
            return {
              success: false,
              errorCode: 'MAX_OTP_ATTEMPTS_EXCEEDED',
              errorMessage: 'Too many incorrect attempts. This OTP is invalidated.',
            };
          }
        }
        return {
          success: false,
          errorCode: verifyRes.errorCode || 'INVALID_OTP',
          errorMessage: verifyRes.errorMessage || 'Invalid OTP code',
        };
      }

      // Successfully verified by Twilio
      this.otpStore.delete(destination);
    } else {
      // Branch B: Standard In-Memory / Mock OTP Path (Email & Mock SMS)
      const stored = this.otpStore.get(destination);

      if (!stored) {
        return {
          success: false,
          errorCode: 'OTP_NOT_FOUND',
          errorMessage: 'No active OTP found for this destination. Request a new OTP.',
        };
      }

      if (stored.expiresAt.getTime() < Date.now()) {
        this.otpStore.delete(destination);
        return {
          success: false,
          errorCode: 'OTP_EXPIRED',
          errorMessage: 'OTP has expired. Please request a new one.',
        };
      }

      // Standard dev/test mode OTP check (allows 123456 for test fixtures when mock is active)
      const isTestOtp =
        process.env.NODE_ENV !== 'production' && credentials.otpCode === '123456';

      if (stored.code !== credentials.otpCode && !isTestOtp) {
        stored.attempts += 1;
        if (stored.attempts >= this.maxAttempts) {
          this.otpStore.delete(destination);
          return {
            success: false,
            errorCode: 'MAX_OTP_ATTEMPTS_EXCEEDED',
            errorMessage: 'Too many incorrect attempts. This OTP is invalidated.',
          };
        }
        return {
          success: false,
          errorCode: 'INVALID_OTP',
          errorMessage: `Incorrect OTP code. ${this.maxAttempts - stored.attempts} attempts remaining.`,
        };
      }

      // Valid OTP consumed: immediately delete to prevent reuse
      this.otpStore.delete(destination);
    }

    const isEmail = destination.includes('@');
    const providerAccountId = `ep_${destination.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const name = credentials.name || (isEmail ? destination.split('@')[0] : 'Resident User');

    const authProvider = credentials.provider === 'EMAIL'
      ? 'EMAIL'
      : credentials.provider === 'PHONE'
      ? 'PHONE'
      : 'EMAIL_PHONE';

    return {
      success: true,
      requiresConfig: false,
      user: {
        id: `usr_${providerAccountId}`,
        authProvider,
        providerAccountId,
        email: isEmail ? destination : `${providerAccountId}@phone.relay.local`,
        phone: isEmail ? undefined : destination,
        name,
        profileImage: credentials.profileImage,
        onboardingStatus: 'AUTHENTICATED',
        residentId: `res_usr_${providerAccountId}`,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };
  }

  public clear(): void {
    this.otpStore.clear();
  }
}

export const emailPhoneAuthProvider = new EmailPhoneAuthProvider();
