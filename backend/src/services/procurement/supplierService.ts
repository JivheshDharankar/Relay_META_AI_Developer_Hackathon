import { prisma } from '../../config/prisma';
import {
  SupplierHardConstraintCheck,
  calculateDistanceKm,
  isLessThan,
  toDecimal,
} from '../../domain/procurement';
import { AuditEventType, EvidenceVerificationStatus, SupplierEvidenceType, SupplierStatus, SupplierVerificationStatus, Prisma } from '@prisma/client';

export interface SupplierFilterInput {
  societyId: string;
  productId: string;
  requestedQuantity: Prisma.Decimal | number | string;
  maxSlaHours?: number; // Defaults to Relay 12-hour SLA invariant
}

export class SupplierService {
  /**
   * Deterministically filters suppliers against all operational hard constraints:
   * 1. Status == ACTIVE and verificationStatus == VERIFIED
   * 2. Product carried in catalog and available
   * 3. Society within supplier's serviceRadiusKm
   * 4. Explicitly verified fulfillment turnaround within 12-hour SLA
   * 5. Quantity >= MOQ
   */
  public async filterEligibleSuppliers(
    input: SupplierFilterInput
  ): Promise<SupplierHardConstraintCheck[]> {
    const maxSlaHours = input.maxSlaHours ?? 12.0;
    const requestedQty = toDecimal(input.requestedQuantity);

    const society = await prisma.society.findUnique({
      where: { id: input.societyId },
    });
    if (!society) {
      throw new Error(`Society ${input.societyId} not found`);
    }

    // Query all suppliers with their product catalog for this product
    const suppliers = await prisma.supplier.findMany({
      include: {
        products: {
          where: { productId: input.productId },
        },
        verificationEvidence: {
          where: {
            evidenceType: SupplierEvidenceType.DELIVERY_CAPABILITY,
            status: EvidenceVerificationStatus.VERIFIED,
            verifiedAt: { not: null },
            verifiedDeliveryHours: { not: null },
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          orderBy: { verifiedAt: 'desc' },
          take: 1,
        },
      },
    });

    const evaluations: SupplierHardConstraintCheck[] = [];

    for (const s of suppliers) {
      const reasons: string[] = [];

      // 1. Status and independent verification checks. Discovery alone is never approval.
      if (s.status !== SupplierStatus.ACTIVE) {
        reasons.push('SUPPLIER_INACTIVE');
      }
      if (s.verificationStatus !== SupplierVerificationStatus.VERIFIED) {
        reasons.push('SUPPLIER_NOT_VERIFIED');
      }

      // 2. Product Compatibility & Availability Check
      const supplierProduct = s.products[0];
      if (!supplierProduct) {
        reasons.push('PRODUCT_NOT_CARRIED');
      } else if (!supplierProduct.available) {
        reasons.push('PRODUCT_UNAVAILABLE');
      }

      // 3. Geographic Service Area Check (Haversine)
      const distanceKm = calculateDistanceKm(
        { latitude: society.latitude, longitude: society.longitude },
        { latitude: s.latitude, longitude: s.longitude }
      );
      const serviceRadiusKm = Number(s.serviceRadiusKm);
      if (distanceKm > serviceRadiusKm) {
        reasons.push(`SERVICE_AREA_EXCEEDED (Distance ${distanceKm}km > Radius ${serviceRadiusKm}km)`);
      }

      // 4. Delivery SLA must come from an explicit, verified supplier commitment.
      // Reliability scores and geographic distance are not evidence of delivery speed.
      const deliveryEvidence = s.verificationEvidence[0];
      const verifiedDeliveryHours = deliveryEvidence?.verifiedDeliveryHours ?? undefined;
      const estimatedDeliveryHours = verifiedDeliveryHours ?? Number.POSITIVE_INFINITY;

      if (verifiedDeliveryHours === undefined) {
        reasons.push('DELIVERY_CAPABILITY_UNVERIFIED');
      } else if (verifiedDeliveryHours > maxSlaHours) {
        reasons.push(`SLA_VIOLATION (Verified supplier commitment ${verifiedDeliveryHours}h exceeds ${maxSlaHours}h limit)`);
      }

      // 5. MOQ Check
      const moq = supplierProduct?.moq ?? new Prisma.Decimal(1.0);
      if (isLessThan(requestedQty, moq)) {
        reasons.push(`MOQ_NOT_MET (Requested ${requestedQty} < MOQ ${moq})`);
      }

      evaluations.push({
        supplierId: s.id,
        supplierName: s.name,
        eligible: reasons.length === 0,
        reasons,
        distanceKm,
        serviceRadiusKm,
        moq,
        requestedQuantity: requestedQty,
        estimatedDeliveryHours,
        maxSlaHours,
      });
    }

    // Record audit event
    await prisma.auditEvent.create({
      data: {
        eventType: AuditEventType.SUPPLIERS_DISCOVERED,
        actor: 'deterministic_core:supplier_service',
        entityType: 'Society',
        entityId: input.societyId,
        metadata: {
          productId: input.productId,
          totalSuppliersEvaluated: suppliers.length,
          eligibleCount: evaluations.filter((e) => e.eligible).length,
          evaluations: evaluations.map((e) => ({
            name: e.supplierName,
            eligible: e.eligible,
            reasons: e.reasons,
          })),
        },
      },
    });

    return evaluations;
  }
}

export const supplierService = new SupplierService();

