import { prisma } from '../../config/prisma';
import {
  AuthorizationCheckInput,
  AuthorizationResult,
  ProcurementError,
  ProcurementErrorCode,
  toDecimal,
  isLessThanOrEqual,
} from '../../domain/procurement';
import { AuditEventType, PaymentMandateStatus } from '@prisma/client';

export class AuthorizationService {
  /**
   * Deterministically verifies whether a resident's payment mandate authorizes the requested amount.
   */
  public async checkAuthorization(
    input: AuthorizationCheckInput
  ): Promise<AuthorizationResult> {
    const requestedDecimal = toDecimal(input.requestedAmount);

    // 1. Verify resident exists
    const resident = await prisma.resident.findUnique({
      where: { id: input.residentId },
      include: {
        paymentMandates: {
          where: { status: PaymentMandateStatus.ACTIVE },
          orderBy: { maximumAmount: 'desc' },
        },
      },
    });

    if (!resident) {
      throw new ProcurementError(
        ProcurementErrorCode.RESIDENT_NOT_FOUND,
        `Resident ${input.residentId} not found`
      );
    }

    // 2. Select mandate: either explicitly specified or active mandate
    let mandate = null;
    if (input.mandateId) {
      mandate = await prisma.paymentMandate.findUnique({
        where: { id: input.mandateId },
      });
      if (!mandate) {
        throw new ProcurementError(
          ProcurementErrorCode.MANDATE_NOT_FOUND,
          `Mandate with ID ${input.mandateId} not found`
        );
      }
      if (mandate.residentId !== input.residentId) {
        throw new ProcurementError(
          ProcurementErrorCode.MANDATE_NOT_FOUND,
          `Mandate ${input.mandateId} does not belong to resident ${input.residentId}`
        );
      }
    } else {
      mandate = resident.paymentMandates[0] || null;
    }

    if (!mandate) {
      const result: AuthorizationResult = {
        authorized: false,
        code: 'REJECTED',
        requestedAmount: requestedDecimal,
        reason: 'NO_ACTIVE_MANDATE',
      };
      await this.recordAudit(input.residentId, result);
      return result;
    }

    // 3. Verify mandate status
    if (mandate.status !== PaymentMandateStatus.ACTIVE) {
      const result: AuthorizationResult = {
        authorized: false,
        code: 'REJECTED',
        mandateId: mandate.id,
        maxAuthorizedAmount: mandate.maximumAmount,
        requestedAmount: requestedDecimal,
        reason: `MANDATE_INACTIVE (Current status: ${mandate.status})`,
      };
      await this.recordAudit(input.residentId, result);
      return result;
    }

    // 4. Verify period validity
    const now = new Date();
    if (now < mandate.periodStart || (mandate.periodEnd && now > mandate.periodEnd)) {
      const result: AuthorizationResult = {
        authorized: false,
        code: 'REJECTED',
        mandateId: mandate.id,
        maxAuthorizedAmount: mandate.maximumAmount,
        requestedAmount: requestedDecimal,
        reason: 'MANDATE_PERIOD_EXPIRED',
      };
      await this.recordAudit(input.residentId, result);
      return result;
    }

    // 5. Verify spending limit: requestedAmount <= mandate.maximumAmount
    if (!isLessThanOrEqual(requestedDecimal, mandate.maximumAmount)) {
      const result: AuthorizationResult = {
        authorized: false,
        code: 'REJECTED',
        mandateId: mandate.id,
        maxAuthorizedAmount: mandate.maximumAmount,
        requestedAmount: requestedDecimal,
        reason: `MANDATE_LIMIT_EXCEEDED (Requested ₹${requestedDecimal} exceeds ceiling ₹${mandate.maximumAmount})`,
      };
      await this.recordAudit(input.residentId, result);
      return result;
    }

    // 6. Cumulative committed spend: completed payments plus in-flight
    // reservations (PENDING/AUTHORIZED/PROCESSING) already consume mandate
    // capacity. The new request must fit in what remains — a per-transaction
    // check alone would allow unlimited overspend in small increments.
    const committed = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: {
        paymentMandateId: mandate.id,
        status: { in: ['SUCCESS', 'PENDING', 'AUTHORIZED', 'PROCESSING'] },
      },
    });
    const committedAmount = toDecimal(committed._sum.amount ?? 0);
    const projectedTotal = committedAmount.plus(requestedDecimal);
    if (!isLessThanOrEqual(projectedTotal, mandate.maximumAmount)) {
      const result: AuthorizationResult = {
        authorized: false,
        code: 'REJECTED',
        mandateId: mandate.id,
        maxAuthorizedAmount: mandate.maximumAmount,
        requestedAmount: requestedDecimal,
        reason: `MANDATE_CUMULATIVE_LIMIT_EXCEEDED (Committed ₹${committedAmount} + requested ₹${requestedDecimal} exceeds ceiling ₹${mandate.maximumAmount})`,
      };
      await this.recordAudit(input.residentId, result);
      return result;
    }

    // Authorization success
    const result: AuthorizationResult = {
      authorized: true,
      code: 'AUTHORIZED',
      mandateId: mandate.id,
      maxAuthorizedAmount: mandate.maximumAmount,
      requestedAmount: requestedDecimal,
    };
    await this.recordAudit(input.residentId, result);
    return result;
  }

  private async recordAudit(residentId: string, result: AuthorizationResult): Promise<void> {
    await prisma.auditEvent.create({
      data: {
        eventType: AuditEventType.AUTHORIZATION_CHECKED,
        actor: 'deterministic_core:authorization_service',
        entityType: 'PaymentMandate',
        entityId: result.mandateId ?? residentId,
        metadata: {
          residentId,
          authorized: result.authorized,
          code: result.code,
          requestedAmount: Number(result.requestedAmount),
          maxAllowed: result.maxAuthorizedAmount ? Number(result.maxAuthorizedAmount) : null,
          reason: result.reason ?? null,
        },
      },
    });
  }
}

export const authorizationService = new AuthorizationService();

