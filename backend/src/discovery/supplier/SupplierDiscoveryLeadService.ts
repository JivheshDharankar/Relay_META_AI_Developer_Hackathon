import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { SupplierCandidate } from './types';

export interface PersistDiscoveryResult {
  processed: number;
  source: string;
}

/**
 * Persists discovered businesses as leads only. This service never creates or
 * activates a Supplier record and never treats map listings as verified vendors.
 */
export class SupplierDiscoveryLeadService {
  public async persistCandidates(candidates: SupplierCandidate[]): Promise<PersistDiscoveryResult> {
    let processed = 0;
    for (const candidate of candidates) {
      if (!candidate.id.trim() || !candidate.name.trim()) continue;
      const source = candidate.source.trim().toLowerCase();
      const observedAt = new Date();
      const categories = candidate.categories as Prisma.InputJsonValue;
      const rawEvidence = {
        source,
        sourceId: candidate.id,
        observedAt: observedAt.toISOString(),
        discoveryOnly: true,
        supplierIdentityVerified: false,
        productAvailabilityVerified: false,
        pricingVerified: false,
      } as Prisma.InputJsonValue;

      const lead = await prisma.supplierDiscoveryLead.upsert({
        where: { source_sourceExternalId: { source, sourceExternalId: candidate.id } },
        create: {
          source,
          sourceExternalId: candidate.id,
          name: candidate.name,
          formattedAddress: candidate.formattedAddress,
          street: candidate.street,
          city: candidate.city,
          state: candidate.state,
          postalCode: candidate.postalCode,
          country: candidate.country,
          latitude: candidate.latitude,
          longitude: candidate.longitude,
          phone: candidate.phone,
          email: candidate.email,
          website: candidate.website,
          categories,
          firstDiscoveredAt: observedAt,
          lastDiscoveredAt: observedAt,
          rawEvidence,
        },
        update: {
          name: candidate.name,
          formattedAddress: candidate.formattedAddress,
          street: candidate.street,
          city: candidate.city,
          state: candidate.state,
          postalCode: candidate.postalCode,
          country: candidate.country,
          latitude: candidate.latitude,
          longitude: candidate.longitude,
          phone: candidate.phone,
          email: candidate.email,
          website: candidate.website,
          categories,
          lastDiscoveredAt: observedAt,
        },
      });

      await prisma.supplierDiscoveryObservation.create({
        data: {
          discoveryLeadId: lead.id,
          source,
          sourceExternalId: candidate.id,
          observedAt,
          normalizedSnapshot: {
            name: candidate.name,
            formattedAddress: candidate.formattedAddress,
            street: candidate.street ?? null,
            city: candidate.city ?? null,
            state: candidate.state ?? null,
            postalCode: candidate.postalCode ?? null,
            country: candidate.country ?? null,
            latitude: candidate.latitude,
            longitude: candidate.longitude,
            categories,
            phone: candidate.phone ?? null,
            email: candidate.email ?? null,
            website: candidate.website ?? null,
            discoveryOnly: true,
            supplierIdentityVerified: false,
            productAvailabilityVerified: false,
            pricingVerified: false,
          },
          rawPayload: rawEvidence,
        },
      });
      processed += 1;
    }

    return { processed, source: candidates[0]?.source ?? 'unknown' };
  }
}

export const supplierDiscoveryLeadService = new SupplierDiscoveryLeadService();
