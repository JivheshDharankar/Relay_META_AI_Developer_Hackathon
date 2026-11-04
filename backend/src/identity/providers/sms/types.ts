export interface SmsDispatchResult {
  success: boolean;
  messageId: string;
  providerName: string;
  simulated?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface VerificationCheckResult {
  success: boolean;
  status?: 'pending' | 'approved' | 'canceled';
  providerName: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface SmsProvider {
  readonly providerName: string;
  readonly isConfigured: boolean;
  sendSms(to: string, body: string): Promise<SmsDispatchResult>;
}

export interface VerifyProvider {
  readonly providerName: string;
  readonly isConfigured: boolean;
  sendVerification(to: string): Promise<SmsDispatchResult>;
  checkVerification(to: string, code: string): Promise<VerificationCheckResult>;
}

