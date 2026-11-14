import { env } from '../../config/env';
import { GeoapifySupplierProvider } from './GeoapifySupplierProvider';
import { mockSupplierDiscoveryProvider } from './MockSupplierDiscoveryProvider';
import { SupplierDiscoveryProvider } from './SupplierDiscoveryProvider';

export * from './types';
export * from './SupplierDiscoveryLeadService';
export * from './SupplierDiscoveryProvider';
export * from './GeoapifySupplierProvider';
export * from './MockSupplierDiscoveryProvider';
export * from './qualification';
export * from './rfq';
export * from './quote';
export * from './negotiation';
export * from './selection';

/**
 * Factory function to retrieve the configured or requested SupplierDiscoveryProvider.
 * Defaults to 'mock' when unconfigured or in tests; uses 'geoapify' when explicitly selected.
 */
export function getSupplierDiscoveryProvider(
  providerName?: 'geoapify' | 'mock'
): SupplierDiscoveryProvider {
  const chosen = providerName || env.SUPPLIER_DISCOVERY_PROVIDER;

  switch (chosen) {
    case 'geoapify':
      return new GeoapifySupplierProvider();
    case 'mock':
    default:
      return mockSupplierDiscoveryProvider;
  }
}
