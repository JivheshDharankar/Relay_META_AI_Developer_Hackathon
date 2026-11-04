import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';
import { SEED_IDS } from '../config/seedConstants';
import { aggregationService } from '../services/procurement';
import { PaymentStatus, Prisma } from '@prisma/client';
import { identityAuditService, userService, profileService, membershipService, societyService, procurementIdentityService } from '../identity';
import { mandateService } from '../payment/mandate/MandateService';
import { MandateValidationError, UpdateMandateLimitSchema } from '../payment/mandate/validation';

export class PortalController {
  /**
   * GET /api/portal/resident
   * Retrieves profile, unit, and community metadata for the active resident.
   */
  public async getResident(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Identity comes exclusively from the session (route also enforces
      // requireAuth + requireResidentOwnership). Client-supplied resident ids
      // are never trusted.
      const residentId = req.residentId;

      if (!residentId) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
        return;
      }

      const resident = await prisma.resident.findUnique({
        where: { id: residentId },
        include: {
          society: true,
          paymentMandates: {
            where: { status: 'ACTIVE' },
            orderBy: { createdAt: 'desc' },
          },
          _count: {
            select: { residentOrders: true },
          },
        },
      });

      if (!resident) {
        const user = req.user || (await userService.getUserForResidentId(residentId));
        if (user) {
          const profile = await profileService.getProfile(user.id);
          const membership = await membershipService.getMembershipByUserId(user.id);
          const society = membership ? await societyService.getSocietyById(membership.societyId) : undefined;
          const mandates = mandateService.listMandates().filter((m) => m.ownerReference === user.residentId || m.ownerReference === user.id);
          const activeMandate = mandates.find((m) => m.status === 'ACTIVE');

          res.status(200).json({
            success: true,
            data: {
              id: user.residentId,
              name: profile?.fullName || user.name || 'Resident',
              email: profile?.email || user.email || `${user.residentId}@relay.local`,
              flatNumber: membership ? `${membership.tower}-${membership.flatNumber}` : 'Flat 101',
              societyId: society?.id || SEED_IDS.society.greenview,
              societyName: society?.name || 'Nashik Heights Residency',
              societyAddress: society?.address || 'Gangapur Road, Nashik',
              societyCity: society?.city || 'Nashik',
              activeMandate: activeMandate
                ? {
                    id: activeMandate.id,
                    maximumAmount: Number(activeMandate.spendingLimit),
                    currency: activeMandate.currency,
                    status: activeMandate.status,
                  }
                : null,
              totalOrders: 0,
            },
          });
          return;
        }

        res.status(404).json({
          success: false,
          error: { code: 'RESIDENT_NOT_FOUND', message: `Resident '${residentId}' not found.` },
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          id: resident.id,
          name: resident.name,
          email: resident.email,
          flatNumber: resident.flatNumber,
          societyId: resident.societyId,
          societyName: resident.society.name,
          societyAddress: resident.society.address,
          societyCity: resident.society.city,
          activeMandate: resident.paymentMandates[0]
            ? {
                id: resident.paymentMandates[0].id,
                maximumAmount: Number(resident.paymentMandates[0].maximumAmount),
                currency: resident.paymentMandates[0].currency,
                status: resident.paymentMandates[0].status,
              }
            : null,
          totalOrders: resident._count.residentOrders,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/portal/orders
   * Retrieves private, resident-owned orders with full item, payment, and delivery context.
   */
  public async getOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Identity comes exclusively from the session (route also enforces
      // requireAuth + requireResidentOwnership). Client-supplied resident ids
      // are never trusted.
      const residentId = req.residentId;

      if (!residentId) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
        return;
      }

      const orders = await prisma.residentOrder.findMany({
        where: { residentId },
        include: {
          items: {
            include: { product: true },
          },
          payments: {
            orderBy: { createdAt: 'desc' },
          },
          communityOrder: {
            include: {
              supplier: true,
              delivery: true,
            },
          },
        },
        orderBy: { requestedAt: 'desc' },
      });

      const formatted = orders.map((o) => ({
        id: o.id,
        status: o.status,
        totalAmount: Number(o.totalAmount),
        currency: o.currency,
        deliveryAddress: o.deliveryAddress,
        requestedAt: o.requestedAt.toISOString(),
        items: o.items.map((i) => ({
          id: i.id,
          productId: i.productId,
          productName: i.product.name,
          category: i.product.category,
          quantity: Number(i.quantity),
          unit: i.product.unit,
          unitPrice: Number(i.unitPrice),
          totalPrice: Number(i.totalPrice),
        })),
        payment: o.payments[0]
          ? {
              id: o.payments[0].id,
              status: o.payments[0].status,
              amount: Number(o.payments[0].amount),
              providerReference: o.payments[0].providerReference,
              createdAt: o.payments[0].createdAt.toISOString(),
            }
          : null,
        communityOrder: o.communityOrder
          ? {
              id: o.communityOrder.id,
              status: o.communityOrder.status,
              supplierName: o.communityOrder.supplier.name,
              deliveryStatus: o.communityOrder.delivery?.status ?? 'PREPARING',
              trackingCode: o.communityOrder.delivery?.trackingCode ?? null,
            }
          : null,
      }));

      res.status(200).json({
        success: true,
        data: formatted,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/portal/community
   * Retrieves society stats, active demand pooling, and collective savings insights.
   */
  public async getCommunity(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Session members always see their OWN society's aggregates — never
      // another society's data presented as theirs. Explicit query selection
      // and the legacy seed default remain for guests/dev callers.
      let societyId = req.query.societyId as string | undefined;
      if (req.user?.id) {
        const mem = await membershipService.getMembershipByUserId(req.user.id);
        if (mem?.societyId) {
          societyId = mem.societyId;
          // Canonicalize on read so members see their own society even before
          // their first procurement run (idempotent, same soc_* identity).
          await procurementIdentityService.ensureCanonicalIdentities(req.user.id);
        }
      }
      if (!societyId) {
        societyId = SEED_IDS.society.greenview;
      }

      const society = await prisma.society.findUnique({
        where: { id: societyId },
        include: {
          _count: {
            select: { residents: true, residentOrders: true, communityOrders: true },
          },
        },
      });

      if (!society) {
        res.status(404).json({
          success: false,
          error: { code: 'SOCIETY_NOT_FOUND', message: `Society '${societyId}' not found.` },
        });
        return;
      }

      // Aggregate compatible demands
      const aggregation = await aggregationService.aggregateSocietyDemand(societyId);

      // Compute total pooled quantity and estimated savings
      const demandPools = aggregation.supplierFacingGroups.map((group) => ({
        productId: group.productId,
        productName: group.productName,
        totalQuantity: Number(group.totalQuantity),
        unit: group.unit,
        contributingOrdersCount: group.contributingOrdersCount,
        estimatedSavingsPct: 15.5, // Bulk collective discount vs individual retail MRP
      }));

      const totalSuppliersCount = await prisma.supplier.count();

      res.status(200).json({
        success: true,
        data: {
          id: society.id,
          name: society.name,
          address: society.address,
          city: society.city,
          state: society.state,
          verified: true,
          totalFlatsRepresentation: 550,
          registeredResidents: society._count.residents,
          verifiedSuppliersCount: totalSuppliersCount,
          totalCommunityOrders: society._count.communityOrders,
          activeDemandPools: demandPools,
          collectiveSavingsEstimatePct: 16.2,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/portal/payments
   * Retrieves active payment mandate, used balance, and payment history for resident.
   */
  public async getPayments(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Identity comes exclusively from the session (route also enforces
      // requireAuth + requireResidentOwnership). Client-supplied resident ids
      // are never trusted.
      const residentId = req.residentId;

      if (!residentId) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
        return;
      }

      const mandates = await prisma.paymentMandate.findMany({
        where: { residentId },
        orderBy: { createdAt: 'desc' },
      });

      const payments = await prisma.payment.findMany({
        where: {
          residentOrder: { residentId },
        },
        include: {
          residentOrder: {
            include: {
              items: { include: { product: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      const activeMandate = mandates.find((m) => m.status === 'ACTIVE') || mandates[0];
      const maxLimit = activeMandate ? new Prisma.Decimal(activeMandate.maximumAmount) : new Prisma.Decimal(0);

      // Sum completed payments with Decimal math (never binary float).
      const totalSpent = payments
        .filter((p) => p.status === PaymentStatus.SUCCESS)
        .reduce((sum, p) => sum.plus(new Prisma.Decimal(p.amount)), new Prisma.Decimal(0));

      const remainingLimit = Prisma.Decimal.max(0, maxLimit.minus(totalSpent));

      res.status(200).json({
        success: true,
        data: {
          mandate: activeMandate
            ? {
                id: activeMandate.id,
                maximumAmount: maxLimit.toNumber(),
                currency: activeMandate.currency,
                status: activeMandate.status,
                authorizedAt: activeMandate.createdAt.toISOString(),
                usedAmount: totalSpent.toNumber(),
                remainingLimit: remainingLimit.toNumber(),
                autoExecutionEnabled: true,
              }
            : null,
          transactions: payments.map((p) => ({
            id: p.id,
            status: p.status,
            amount: Number(p.amount),
            currency: p.currency,
            providerReference: p.providerReference,
            failureCode: p.failureCode,
            executedAt: (p.completedAt ?? p.createdAt).toISOString(),
            orderId: p.residentOrderId,
            itemDescription: p.residentOrder
              ? p.residentOrder.items
                  .map((i) => `${Number(i.quantity)} ${i.product.unit} ${i.product.name}`)
                  .join(', ')
              : 'Procurement Payment',
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/portal/mandate
   * Updates the authenticated resident's own active payment mandate limit.
   * The resident is derived exclusively from the session; no client-supplied
   * resident, user, or mandate identifier is trusted (IDOR-safe by construction).
   */
  public async updateMandateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user || !req.residentId) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
        return;
      }
      const user = req.user;
      const residentId = req.residentId;

      const parsed = UpdateMandateLimitSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_MANDATE_LIMIT',
            message: parsed.error.issues[0]?.message || 'Invalid spending limit',
          },
        });
        return;
      }

      // Same ownership predicate as the existing session-scoped mandate reads:
      // ownerReference matches the session resident id or the user id.
      const ownedActive = mandateService
        .listMandates()
        .filter(
          (m) =>
            (m.ownerReference === residentId || m.ownerReference === user.id) &&
            m.status === 'ACTIVE'
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const target = ownedActive[0];
      if (!target) {
        res.status(404).json({
          success: false,
          error: {
            code: 'NO_ACTIVE_MANDATE',
            message: 'No active payment mandate found. Complete onboarding to authorize a spending limit.',
          },
        });
        return;
      }

      let previousLimit: number;
      try {
        const result = await mandateService.updateSpendingLimit(target.id, parsed.data.spendingLimit);
        previousLimit = result.previousLimit;
      } catch (err) {
        if (err instanceof MandateValidationError) {
          res.status(400).json({
            success: false,
            error: { code: 'INVALID_MANDATE_LIMIT', message: err.errors[0] },
          });
          return;
        }
        throw err;
      }

      const mandate = mandateService.getMandate(target.id)!;

      // Durable mirror: refresh the existing mirror row (if the mandate was
      // mirrored by ensureCanonicalIdentities) so the updated limit survives
      // refresh, re-login, and process restart. Never fabricates Resident or
      // Society rows; the in-memory mandate stays authoritative for payment
      // authorization exactly as before.
      await prisma.paymentMandate.updateMany({
        where: { id: mandate.id },
        data: {
          maximumAmount: mandate.spendingLimit,
          currency: mandate.currency,
        },
      });

      identityAuditService.emit('PAYMENT_MANDATE_LIMIT_UPDATED', user.id, {
        mandateId: mandate.id,
        previousLimit,
        newLimit: mandate.spendingLimit,
        currency: mandate.currency,
      });

      res.status(200).json({
        success: true,
        data: {
          id: mandate.id,
          maximumAmount: mandate.spendingLimit,
          spentAmount: mandate.spentAmount,
          reservedAmount: mandate.reservedAmount,
          remainingLimit: mandateService.getRemainingCapacity(mandate.id),
          currency: mandate.currency,
          status: mandate.status,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/portal/suppliers
   * Retrieves verified suppliers serving the society.
   */
  public async getSuppliers(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const suppliers = await prisma.supplier.findMany({
        include: {
          products: {
            include: { product: true },
          },
        },
      });

      res.status(200).json({
        success: true,
        data: suppliers.map((s) => ({
          id: s.id,
          name: s.name,
          city: s.city,
          rating: Number(s.reliabilityScore) * 5,
          reliabilityScorePct: Math.round(Number(s.reliabilityScore) * 100),
          serviceRadiusKm: Number(s.serviceRadiusKm),
          slaHours: 12,
          catalog: s.products.map((p) => ({
            productId: p.productId,
            name: p.product.name,
            category: p.product.category,
            unit: p.product.unit,
            basePrice: Number(p.basePrice),
            moq: Number(p.moq),
          })),
        })),
      });
    } catch (err) {
      next(err);
    }
  }
}

export const portalController = new PortalController();
