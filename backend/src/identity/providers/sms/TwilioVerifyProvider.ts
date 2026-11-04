import { SmsDispatchResult, VerificationCheckResult, VerifyProvider } from './types';

export interface TwilioVerifyConfig {
  accountSid?: string;
  authToken?: string;
  verifyServiceSid?: string;
  fetchFn?: typeof fetch;
}

export class TwilioVerifyProvider implements VerifyProvider {
  public readonly providerName = 'twilio-verify';
  private readonly accountSid?: string;
  private readonly authToken?: string;
  private readonly verifyServiceSid?: string;
  private readonly fetchFn: typeof fetch;

  constructor(config?: TwilioVerifyConfig) {
    this.accountSid =
      config && 'accountSid' in config ? config.accountSid : process.env.TWILIO_ACCOUNT_SID;
    this.authToken =
      config && 'authToken' in config ? config.authToken : process.env.TWILIO_AUTH_TOKEN;
    this.verifyServiceSid =
      config && 'verifyServiceSid' in config
        ? config.verifyServiceSid
        : (process.env.TWILIO_VERIFY_SERVICE_SID ?? process.env.TWILIO_SERVICE_SID);
    this.fetchFn = config?.fetchFn ?? globalThis.fetch;
  }

  public validateConfig(): { valid: boolean; missing: string[]; error?: string } {
    const missing: string[] = [];
    if (!this.accountSid || this.accountSid.trim().length === 0) {
      missing.push('TWILIO_ACCOUNT_SID');
    }
    if (!this.authToken || this.authToken.trim().length === 0) {
      missing.push('TWILIO_AUTH_TOKEN');
    }
    if (!this.verifyServiceSid || this.verifyServiceSid.trim().length === 0) {
      missing.push('TWILIO_VERIFY_SERVICE_SID');
    }

    if (missing.length > 0) {
      return {
        valid: false,
        missing,
        error: `Twilio Verify configuration missing: ${missing.join(', ')}`,
      };
    }

    if (!/^AC[a-zA-Z0-9]{32}$/.test(this.accountSid!.trim())) {
      return {
        valid: false,
        missing: [],
        error: 'TWILIO_ACCOUNT_SID format is invalid (must start with AC followed by 32 alphanumeric characters)',
      };
    }

    if (!/^VA[a-zA-Z0-9]{32}$/.test(this.verifyServiceSid!.trim())) {
      return {
        valid: false,
        missing: [],
        error: 'TWILIO_VERIFY_SERVICE_SID format is invalid (must start with VA followed by 32 alphanumeric characters)',
      };
    }

    return { valid: true, missing: [] };
  }

  public get isConfigured(): boolean {
    return this.validateConfig().valid;
  }

  public normalizePhoneNumber(phone: string): { valid: boolean; phone: string; error?: string } {
    if (!phone || typeof phone !== 'string') {
      return { valid: false, phone: '', error: 'Destination phone number is required' };
    }
    const cleaned = phone.trim().replace(/[\s\-\(\)]/g, '');
    const e164 = cleaned.startsWith('+') ? cleaned : `+${cleaned}`;

    if (!/^\+[1-9]\d{6,14}$/.test(e164)) {
      return {
        valid: false,
        phone: e164,
        error: 'Invalid phone number format. Expected E.164 format (e.g. +919876543210 or +14155552671)',
      };
    }

    return { valid: true, phone: e164 };
  }

  /**
   * Dispatches an OTP verification through Twilio Verify SMS.
   * Guarantees:
   * - No OTP codes or credentials in client responses or console logs
   * - Fails closed on missing or invalid configuration
   * - Maps Twilio errors to safe domain errors
   */
  public async sendVerification(to: string): Promise<SmsDispatchResult> {
    const configCheck = this.validateConfig();
    if (!configCheck.valid) {
      return {
        success: false,
        messageId: '',
        providerName: this.providerName,
        errorCode: 'TWILIO_UNCONFIGURED',
        errorMessage: configCheck.error || 'Twilio Verify provider is not properly configured.',
      };
    }

    const phoneCheck = this.normalizePhoneNumber(to);
    if (!phoneCheck.valid) {
      return {
        success: false,
        messageId: '',
        providerName: this.providerName,
        errorCode: 'INVALID_PHONE_FORMAT',
        errorMessage: phoneCheck.error || 'Invalid destination phone number format.',
      };
    }

    try {
      const url = `https://verify.twilio.com/v2/Services/${this.verifyServiceSid}/Verifications`;
      const basicAuth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

      const params = new URLSearchParams();
      params.append('To', phoneCheck.phone);
      params.append('Channel', 'sms');

      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      const responseText = await response.text();
      let responseJson: any = {};
      try {
        responseJson = JSON.parse(responseText);
      } catch {
        // non-json response
      }

      if (!response.ok) {
        const twilioCode = responseJson?.code;
        const twilioMessage = responseJson?.message || responseText;

        if (twilioCode === 21608 || String(twilioMessage).toLowerCase().includes('unverified')) {
          return {
            success: false,
            messageId: '',
            providerName: this.providerName,
            errorCode: 'TWILIO_TRIAL_RESTRICTION',
            errorMessage:
              'Twilio Trial Account: destination phone number is unverified. In trial mode, SMS can only be sent to numbers verified in your Twilio Console (twilio.com/user/account/phone-numbers/verified).',
          };
        }

        if (twilioCode === 21211 || twilioCode === 60200) {
          return {
            success: false,
            messageId: '',
            providerName: this.providerName,
            errorCode: 'INVALID_PHONE_FORMAT',
            errorMessage: 'Invalid phone number format rejected by Twilio.',
          };
        }

        if (twilioCode === 60203 || response.status === 429) {
          return {
            success: false,
            messageId: '',
            providerName: this.providerName,
            errorCode: 'MAX_OTP_ATTEMPTS_EXCEEDED',
            errorMessage: 'Twilio rate limit: Max send attempts reached for this phone number. Please wait before trying again.',
          };
        }

        if (response.status === 401 || response.status === 403 || twilioCode === 20003) {
          return {
            success: false,
            messageId: '',
            providerName: this.providerName,
            errorCode: 'TWILIO_AUTH_ERROR',
            errorMessage: 'Twilio authentication failed: Account SID or Auth Token is invalid.',
          };
        }

        return {
          success: false,
          messageId: '',
          providerName: this.providerName,
          errorCode: 'TWILIO_REJECTED_REQUEST',
          errorMessage: `Twilio Verify error ${response.status} (code ${twilioCode || 'unknown'}): ${twilioMessage}`,
        };
      }

      const sid = responseJson?.sid || `VE_${Date.now()}`;
      return {
        success: true,
        messageId: sid,
        providerName: this.providerName,
      };
    } catch (err: any) {
      return {
        success: false,
        messageId: '',
        providerName: this.providerName,
        errorCode: 'TWILIO_NETWORK_ERROR',
        errorMessage: err.message || 'Network timeout or error communicating with Twilio Verify API',
      };
    }
  }

  /**
   * Checks an OTP verification code via Twilio VerificationCheck endpoint.
   * Guarantees:
   * - No secrets or sensitive OTP data in errors
   * - Fails closed on invalid inputs or malformed codes
   * - Expiry and replay protection
   */
  public async checkVerification(to: string, code: string): Promise<VerificationCheckResult> {
    const configCheck = this.validateConfig();
    if (!configCheck.valid) {
      return {
        success: false,
        providerName: this.providerName,
        errorCode: 'TWILIO_UNCONFIGURED',
        errorMessage: configCheck.error || 'Twilio Verify provider is not properly configured.',
      };
    }

    const phoneCheck = this.normalizePhoneNumber(to);
    if (!phoneCheck.valid) {
      return {
        success: false,
        providerName: this.providerName,
        errorCode: 'INVALID_PHONE_FORMAT',
        errorMessage: phoneCheck.error || 'Invalid destination phone number format.',
      };
    }

    const trimmedCode = (code || '').trim();
    if (!trimmedCode || !/^\d{4,10}$/.test(trimmedCode)) {
      return {
        success: false,
        providerName: this.providerName,
        errorCode: 'MALFORMED_OTP',
        errorMessage: 'Verification code must be between 4 and 10 numeric digits.',
      };
    }

    try {
      const url = `https://verify.twilio.com/v2/Services/${this.verifyServiceSid}/VerificationCheck`;
      const basicAuth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

      const params = new URLSearchParams();
      params.append('To', phoneCheck.phone);
      params.append('Code', trimmedCode);

      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      const responseText = await response.text();
      let responseJson: any = {};
      try {
        responseJson = JSON.parse(responseText);
      } catch {
        // non-json response
      }

      if (response.status === 404 || responseJson?.code === 20404) {
        return {
          success: false,
          providerName: this.providerName,
          errorCode: 'OTP_EXPIRED',
          errorMessage: 'Verification code has expired or was already used. Please request a new code.',
        };
      }

      if (response.status === 429 || responseJson?.code === 60202) {
        return {
          success: false,
          providerName: this.providerName,
          errorCode: 'MAX_OTP_ATTEMPTS_EXCEEDED',
          errorMessage: 'Too many incorrect verification attempts. This verification code has been canceled.',
        };
      }

      if (!response.ok) {
        return {
          success: false,
          providerName: this.providerName,
          errorCode: 'TWILIO_VERIFICATION_ERROR',
          errorMessage: `Twilio Verify Check returned status ${response.status}: ${responseJson?.message || responseText}`,
        };
      }

      const status = responseJson?.status;
      const valid = responseJson?.valid === true;

      if (status === 'approved' && valid) {
        return {
          success: true,
          status: 'approved',
          providerName: this.providerName,
        };
      }

      return {
        success: false,
        status: status || 'pending',
        providerName: this.providerName,
        errorCode: 'INVALID_OTP',
        errorMessage: 'Incorrect verification code. Please check and try again.',
      };
    } catch (err: any) {
      return {
        success: false,
        providerName: this.providerName,
        errorCode: 'TWILIO_NETWORK_ERROR',
        errorMessage: err.message || 'Network error communicating with Twilio Verify Check',
      };
    }
  }
}
