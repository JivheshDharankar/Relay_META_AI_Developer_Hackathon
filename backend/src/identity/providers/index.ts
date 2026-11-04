import { AuthProviderType, ProviderMetadata } from '../types';
import { AuthProvider } from './AuthProvider';
import { googleAuthProvider } from './GoogleAuthProvider';
import { emailPhoneAuthProvider } from './EmailPhoneAuthProvider';

export * from './AuthProvider';
export * from './GoogleAuthProvider';
export * from './EmailPhoneAuthProvider';
export * from './sms/types';
export * from './sms/TwilioSmsProvider';
export * from './sms/TwilioVerifyProvider';
export * from './sms/MockSmsProvider';
export * from './sms/SmsService';
export * from './email/EmailService';

export class AuthProviderRegistry {
  private providers = new Map<AuthProviderType, AuthProvider>();

  constructor() {
    this.register(googleAuthProvider);
    this.register(emailPhoneAuthProvider);
  }

  public register(provider: AuthProvider): void {
    this.providers.set(provider.providerName, provider);
  }

  public get(name: AuthProviderType): AuthProvider | undefined {
    if (name === 'EMAIL' || name === 'PHONE') {
      return this.providers.get('EMAIL_PHONE');
    }
    return this.providers.get(name);
  }

  public has(name: AuthProviderType): boolean {
    if (name === 'EMAIL' || name === 'PHONE') {
      return this.providers.has('EMAIL_PHONE');
    }
    return this.providers.has(name);
  }

  public list(): AuthProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Returns public status metadata for all authentication paths.
   */
  public getAllMetadata(): ProviderMetadata[] {
    const list: ProviderMetadata[] = [
      googleAuthProvider.getMetadata(),
      {
        id: 'EMAIL',
        name: 'Email OTP',
        type: 'OTP',
        status: emailPhoneAuthProvider.status,
        isAvailable: true,
        requiresConfig: false,
      },
      {
        id: 'PHONE',
        name: 'Phone OTP',
        type: 'OTP',
        status: emailPhoneAuthProvider.status,
        isAvailable: true,
        requiresConfig: false,
      },
    ];

    return list;
  }
}

export const authProviderRegistry = new AuthProviderRegistry();
