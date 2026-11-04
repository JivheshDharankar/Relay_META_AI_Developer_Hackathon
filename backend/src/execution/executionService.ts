import { prisma } from '../config/prisma';
import {
  PaymentStatus,
  DeliveryStatus,
  CommunityOrderStatus,
  ResidentOrderStatus,
  AuditEventType,
} from '@prisma/client';
import { PaymentAdapter, PaymentAdapterError } from './payment/PaymentAdapter';
import { mockPaymentProvider } from './payment/MockPaymentProvider';
import { SupplierAdapter, SupplierAdapterError } from './supplier/SupplierAdapter';
import { mockSupplierProvider } from './supplier/MockSupplierProvider';
import { DeliverySimulator, deliverySimulator as defaultSimulator } from './delivery/DeliverySimulator';
import { authorizationService, allocationService, reconciliationService } from '../services/procurement';
import { toDecimal, isDecimalEqual } from '../domain/procurement';
import {
  ExecutionError,
  ExecutePaymentInput,
  ExecutePaymentResult,
  ExecuteSupplierOrderInput,
  ExecuteSupplierOrderResult,
  ExecuteFullCycleInput,
  ExecuteFullCycleResult,
} from './types';
import { DeliveryTransitionResult, DeliveryStateSnapshot } from './delivery/types';

export class ExecutionService {
  private paymentAdapter: PaymentAdapter;
  private supplierAdapter: SupplierAdapter;
  private deliverySimulator: DeliverySimulator;

  constructor(options?: {
    paymentAdapter?: PaymentAdapter;
    supplierAdapter?: SupplierAdapter;
    deliverySimulator?: DeliverySimulator;
  }) {
    this.paymentAdapter = options?.paymentAdapter ?? mockPaymentProvider;
    this.supplierAdapter = options?.supplierAdapter ?? mockSupplierProvider;
    this.deliverySimulator = options?.deliverySimulator ?? defaultSimulator;
  }

  public setPaymentAdapter(adapter: PaymentAdapter): void {
    this.paymentAdapter = adapter;
  }

  public setSupplierAdapter(adapter: SupplierAdapter): void {
    this.supplierAdapter = adapter;
  }

  /**
   * Executes payment for an individual resident order.
   *
   * Hard Invariants Enforced:
   * 1. Deterministic authorization check MUST pass (payment.amount <= mandate.maximumAmount).
   * 2. Payment adapter receives already-authorized amount; never overrides limits.
   * 3. Idempotent: returns existing payment if already processed.
   * 4. State transitions: residentOrder -> PAID upon success.
   */
  public async executeResidentPayment(input: ExecutePaymentInput): Promise<ExecutePaymentResult> {
    const order = await prisma.residentOrder.findUnique({
      where: { id: input.residentOrderId },
      include: {
        resident: {
          include: {
            paymentMandates: {
              where: { status: 'ACTIVE' },
              orderBy: { createdAt: 'desc' },
            },
          },
        },
      },
    });

    if (!order) {
      throw new ExecutionError(
        'RESIDENT_ORDER_NOT_FOUND',
        `ResidentOrder '${input.residentOrderId}' not found`
      );
    }

    if (input.expectedResidentId && order.residentId !== input.expectedResidentId) {
      throw new ExecutionError(
        'FORBIDDEN',
        `Access denied: order '${input.residentOrderId}' belongs to another resident`
      );
    }

    // Check if payment was already successfully executed for this order or order already PAID
    const existingSuccessfulPayment = await prisma.payment.findFirst({
      where: {
        residentOrderId: order.id,
        status: PaymentStatus.SUCCESS,
      },
    });

    if (order.status === ResidentOrderStatus.PAID || existingSuccessfulPayment) {
      const pay = existingSuccessfulPayment;

      if (pay) {
        return {
          success: true,
          orderId: order.id,
          residentOrderStatus: ResidentOrderStatus.PAID,
          payment: {
            success: true,
            paymentId: pay.id,
            providerReference: pay.providerReference ?? 'PREVIOUSLY_EXECUTED',
            status: PaymentStatus.SUCCESS,
            amount: Number(pay.amount),
            currency: pay.currency,
            executedAt: pay.completedAt ?? pay.createdAt,
            isDuplicate: true,
          },
        };
      }
    }

    // Idempotency check by key
    if (input.idempotencyKey) {
      const existingPayment = await prisma.payment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existingPayment) {
        return {
          success: existingPayment.status === PaymentStatus.SUCCESS,
          orderId: order.id,
          residentOrderStatus: existingPayment.status === PaymentStatus.SUCCESS ? ResidentOrderStatus.PAID : order.status,
          payment: {
            success: existingPayment.status === PaymentStatus.SUCCESS,
            paymentId: existingPayment.id,
            providerReference: existingPayment.providerReference ?? 'PREVIOUSLY_EXECUTED',
            status: existingPayment.status,
            amount: Number(existingPayment.amount),
            currency: existingPayment.currency,
            executedAt: existingPayment.completedAt ?? existingPayment.createdAt,
            isDuplicate: true,
          },
        };
      }
    }

    // 1. Resolve Mandate
    let mandate: { id: string; status: any; maximumAmount: any } | null = null;
    if (input.paymentMandateId) {
      const foundMandate = await prisma.paymentMandate.findUnique({
        where: { id: input.paymentMandateId },
      });
      if (!foundMandate) {
        throw new ExecutionError(
          'PAYMENT_MANDATE_NOT_FOUND',
          `PaymentMandate '${input.paymentMandateId}' not found`
        );
      }
      if (foundMandate.residentId !== order.residentId) {
        throw new ExecutionError(
          'PAYMENT_MANDATE_NOT_FOUND',
          `PaymentMandate '${input.paymentMandateId}' does not belong to resident '${order.residentId}'`
        );
      }
      mandate = foundMandate;
    } else {
      mandate = order.resident.paymentMandates[0] || null;
    }

    if (!mandate) {
      throw new ExecutionError(
        'PAYMENT_MANDATE_NOT_FOUND',
        `No active PaymentMandate found for resident '${order.residentId}'`
      );
    }

    const requestedAmount = input.amount ?? Number(order.totalAmount);

    // Amount sanity: a non-positive or non-finite amount can never be
    // authorized or charged (the controller's Number(...) coercion must
    // not smuggle NaN through).
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      throw new ExecutionError(
        'INVALID_AMOUNT',
        `Payment amount must be a positive finite number; received '${input.amount}'`
      );
    }

    // Order-state gate: cancelled/failed orders are never payable.
    if (order.status === ResidentOrderStatus.CANCELLED || order.status === ResidentOrderStatus.FAILED) {
      throw new ExecutionError(
        'ORDER_NOT_PAYABLE',
        `Resident order '${order.id}' is ${order.status} and cannot be paid`
      );
    }

    // 2. Deterministic Authorization Check
    const authResult = await authorizationService.checkAuthorization({
      residentId: order.residentId,
      societyId: order.societyId,
      requestedAmount,
      mandateId: mandate.id,
      purpose: input.purpose ?? 'Community Order Payment Execution',
    });

    if (!authResult.authorized) {
      // Record failed audit event
      await prisma.auditEvent.create({
        data: {
          eventType: AuditEventType.PAYMENT_EXECUTION_FAILED,
          actor: 'execution:payment',
          entityType: 'ResidentOrder',
          entityId: order.id,
          metadata: {
            mandateId: mandate.id,
            requestedAmount,
            reason: authResult.reason,
            code: authResult.code,
          },
        },
      });

      throw new ExecutionError(
        authResult.reason?.includes('MANDATE_INACTIVE')
          ? 'MANDATE_INACTIVE'
          : authResult.reason?.includes('MANDATE_PERIOD_EXPIRED')
            ? 'MANDATE_PERIOD_EXPIRED'
            : 'MANDATE_LIMIT_EXCEEDED',
        `Payment authorization rejected: ${authResult.reason}`,
        authResult
      );
    }

    // Amount mismatch check: Never charge an amount different from the deterministic order amount
    if (input.amount !== undefined) {
      const requestedDec = toDecimal(input.amount);
      const orderDec = toDecimal(order.totalAmount);
      if (!isDecimalEqual(requestedDec, orderDec)) {
        throw new ExecutionError(
          'AMOUNT_MISMATCH',
          `Payment amount ₹${requestedDec.toFixed(2)} does not match resident order total ₹${orderDec.toFixed(2)}`
        );
      }
    }

    // 3. Record PAYMENT_EXECUTION_STARTED
    await prisma.auditEvent.create({
      data: {
        eventType: AuditEventType.PAYMENT_EXECUTION_STARTED,
        actor: 'execution:payment',
        entityType: 'ResidentOrder',
        entityId: order.id,
        metadata: {
          mandateId: mandate.id,
          amount: requestedAmount,
          currency: order.currency,
        },
      },
    });

    // 4. Claim the payment BEFORE calling the provider: a PROCESSING row
    // keyed by the idempotency key (or the order itself) is inserted first.
    // The unique key makes concurrent duplicates fail fast instead of both
    // charging the provider; only the claim holder proceeds to execute.
    const claimKey = input.idempotencyKey ?? `order:${order.id}`;
    let claimId: string;
    try {
      const claim = await prisma.payment.create({
        data: {
          idempotencyKey: claimKey,
          residentOrderId: order.id,
          paymentMandateId: mandate.id,
          amount: requestedAmount,
          currency: order.currency,
          status: PaymentStatus.PROCESSING,
          authorizedAt: new Date(),
        },
      });
      claimId = claim.id;
    } catch (claimErr: any) {
      if (claimErr?.code === 'P2002') {
        const existing = await prisma.payment.findUnique({
          where: { idempotencyKey: claimKey },
        });
        if (existing?.status === PaymentStatus.SUCCESS) {
          return {
            success: true,
            orderId: order.id,
            residentOrderStatus: ResidentOrderStatus.PAID,
            payment: {
              success: true,
              paymentId: existing.id,
              providerReference: existing.providerReference ?? 'PREVIOUSLY_EXECUTED',
              status: PaymentStatus.SUCCESS,
              amount: Number(existing.amount),
              currency: existing.currency,
              executedAt: existing.completedAt ?? existing.createdAt,
              isDuplicate: true,
            },
          };
        }
        throw new ExecutionError(
          'PAYMENT_IN_PROGRESS',
          `A payment for order '${order.id}' is already in progress under this idempotency key`
        );
      }
      throw claimErr;
    }

    // 5. Invoke PaymentAdapter (only the claim holder reaches here)
    let adapterResponse;
    try {
      adapterResponse = await this.paymentAdapter.execute({
        residentOrderId: order.id,
        paymentMandateId: mandate.id,
        amount: requestedAmount,
        currency: order.currency,
        idempotencyKey: claimKey,
        purpose: input.purpose,
      });
    } catch (err) {
      const code = err instanceof PaymentAdapterError ? err.code : 'PAYMENT_GATEWAY_UNAVAILABLE';
      const reason = err instanceof Error ? err.message : 'Payment provider error';
      // Release the claim as FAILED (key freed) so an honest retry is
      // possible; the failure itself stays persisted.
      await prisma.payment.update({
        where: { id: claimId },
        data: {
          idempotencyKey: null,
          status: PaymentStatus.FAILED,
          failureCode: code,
          failedAt: new Date(),
        },
      }).catch(() => undefined);
      await prisma.auditEvent.create({
        data: {
          eventType: AuditEventType.PAYMENT_EXECUTION_FAILED,
          actor: 'execution:payment',
          entityType: 'ResidentOrder',
          entityId: order.id,
          metadata: { failureCode: code, failureReason: reason },
        },
      });
      throw new ExecutionError(code, reason);
    }

    const now = new Date();

    if (!adapterResponse.success) {
      // Persist the failure on the claim row and free the idempotency key
      // so a corrected retry is not mistaken for a duplicate charge.
      await prisma.payment.update({
        where: { id: claimId },
        data: {
          idempotencyKey: null,
          status: PaymentStatus.FAILED,
          providerReference: adapterResponse.providerReference,
          failureCode: adapterResponse.failureCode ?? 'PAYMENT_EXECUTION_FAILED',
          failedAt: now,
        },
      });

      await prisma.auditEvent.create({
        data: {
          eventType: AuditEventType.PAYMENT_EXECUTION_FAILED,
          actor: 'execution:payment',
          entityType: 'ResidentOrder',
          entityId: order.id,
          metadata: {
            providerReference: adapterResponse.providerReference,
            failureCode: adapterResponse.failureCode,
            failureReason: adapterResponse.failureReason,
          },
        },
      });

      throw new ExecutionError(
        adapterResponse.failureCode ?? 'PAYMENT_EXECUTION_FAILED',
        adapterResponse.failureReason ?? 'Payment processing failed at provider level.'
      );
    }

    // 5. Transactional Success State Transition with Concurrency Row Lock
    try {
      const txResult = await prisma.$transaction(async (tx) => {
        // Row lock resident order to serialize concurrent executions
        await tx.$queryRaw`SELECT id, status FROM resident_orders WHERE id = ${order.id} FOR UPDATE`;

        // Check if concurrent thread already created a successful payment
        const concurrentSuccess = await tx.payment.findFirst({
          where: {
            residentOrderId: order.id,
            status: PaymentStatus.SUCCESS,
          },
        });

        if (concurrentSuccess && concurrentSuccess.id !== claimId) {
          // Another execution settled this order first: drop our claim so
          // no stranded PROCESSING row keeps consuming mandate capacity.
          await tx.payment.delete({ where: { id: claimId } }).catch(() => undefined);
          return {
            orderId: order.id,
            residentOrderStatus: ResidentOrderStatus.PAID,
            payment: {
              success: true,
              paymentId: concurrentSuccess.id,
              providerReference: concurrentSuccess.providerReference ?? adapterResponse.providerReference,
              status: PaymentStatus.SUCCESS,
              amount: Number(concurrentSuccess.amount),
              currency: concurrentSuccess.currency,
              executedAt: concurrentSuccess.completedAt ?? concurrentSuccess.createdAt,
              isDuplicate: true,
            },
          };
        }

        const newPayment = await tx.payment.update({
          where: { id: claimId },
          data: {
            status: PaymentStatus.SUCCESS,
            providerReference: adapterResponse.providerReference,
            authorizedAt: now,
            completedAt: now,
          },
        });

        const updated = await tx.residentOrder.update({
          where: { id: order.id },
          data: {
            status: ResidentOrderStatus.PAID,
          },
        });

        await tx.auditEvent.create({
          data: {
            eventType: AuditEventType.PAYMENT_EXECUTION_SUCCEEDED,
            actor: 'execution:payment',
            entityType: 'ResidentOrder',
            entityId: order.id,
            metadata: {
              paymentId: newPayment.id,
              amount: requestedAmount,
              providerReference: adapterResponse.providerReference,
            },
          },
        });

        return {
          orderId: updated.id,
          residentOrderStatus: updated.status,
          payment: adapterResponse,
        };
      });

      return {
        success: true,
        orderId: txResult.orderId,
        residentOrderStatus: txResult.residentOrderStatus,
        payment: txResult.payment,
      };
    } catch (txErr: any) {
      if (txErr.code === 'P2002' || txErr.message?.includes('idempotencyKey')) {
        const duplicate = await prisma.payment.findFirst({
          where: { residentOrderId: order.id, status: PaymentStatus.SUCCESS },
        });
        if (duplicate) {
          return {
            success: true,
            orderId: order.id,
            residentOrderStatus: ResidentOrderStatus.PAID,
            payment: {
              success: true,
              paymentId: duplicate.id,
              providerReference: duplicate.providerReference ?? adapterResponse.providerReference,
              status: PaymentStatus.SUCCESS,
              amount: Number(duplicate.amount),
              currency: duplicate.currency,
              executedAt: duplicate.completedAt ?? duplicate.createdAt,
              isDuplicate: true,
            },
          };
        }
      }
      throw txErr;
    }
  }

  /**
   * Executes supplier-side procurement for a CommunityOrder.
   *
   * Hard Invariants Enforced:
   * 1. Supplier receives strictly anonymized consolidated demand (zero resident PII).
   * 2. CommunityOrder status transitions to SUPPLIER_CONFIRMED.
   * 3. Idempotent against duplicate purchase orders.
   */
  public async executeSupplierProcurement(
    input: ExecuteSupplierOrderInput
  ): Promise<ExecuteSupplierOrderResult> {
    const communityOrder = await prisma.communityOrder.findUnique({
      where: { id: input.communityOrderId },
      include: {
        society: true,
        supplier: true,
        items: {
          include: { product: true },
        },
      },
    });

    if (!communityOrder) {
      throw new ExecutionError(
        'COMMUNITY_ORDER_NOT_FOUND',
        `CommunityOrder '${input.communityOrderId}' not found`
      );
    }

    // Prepare strictly anonymized purchase order
    const poRequest = {
      communityOrderId: communityOrder.id,
      societyId: communityOrder.societyId,
      societyName: communityOrder.society.name,
      deliveryAddress: communityOrder.society.address,
      supplierId: communityOrder.supplierId,
      deliveryDeadline: communityOrder.deliveryDeadline,
      idempotencyKey: input.idempotencyKey,
      items: communityOrder.items.map((i) => ({
        productId: i.productId,
        productName: i.product.name,
        quantity: Number(i.totalQuantity),
        unit: i.product.unit,
        negotiatedUnitPrice: Number(i.negotiatedUnitPrice),
        totalPrice: Number(i.totalPrice),
      })),
    };

    // 1. Record SUPPLIER_PO_SUBMITTED
    await prisma.auditEvent.create({
      data: {
        eventType: AuditEventType.SUPPLIER_PO_SUBMITTED,
        actor: 'execution:supplier',
        entityType: 'CommunityOrder',
        entityId: communityOrder.id,
        metadata: {
          supplierId: communityOrder.supplierId,
          supplierName: communityOrder.supplier.name,
          societyName: communityOrder.society.name,
          itemCount: poRequest.items.length,
          totalAmount: Number(communityOrder.totalAmount),
        },
      },
    });

    // 2. Submit to SupplierAdapter
    let poResponse;
    try {
      poResponse = await this.supplierAdapter.submitPurchaseOrder(poRequest);
    } catch (err) {
      const code = err instanceof SupplierAdapterError ? err.code : 'SUPPLIER_UNAVAILABLE';
      const reason = err instanceof Error ? err.message : 'Supplier communication failed.';
      throw new ExecutionError(code, reason);
    }

    if (!poResponse.success) {
      await prisma.auditEvent.create({
        data: {
          eventType: AuditEventType.SUPPLIER_REJECTED,
          actor: 'execution:supplier',
          entityType: 'CommunityOrder',
          entityId: communityOrder.id,
          metadata: {
            supplierId: communityOrder.supplierId,
            poReference: poResponse.poReference,
            failureCode: poResponse.failureCode,
            failureReason: poResponse.failureReason,
          },
        },
      });

      throw new ExecutionError(
        poResponse.failureCode ?? 'SUPPLIER_REJECTED_ORDER',
        poResponse.failureReason ?? 'Supplier rejected bulk purchase order.'
      );
    }

    // 3. Confirm Order with Supplier
    await this.supplierAdapter.confirmOrder(poResponse.poReference);

    // 4. Update CommunityOrder state to SUPPLIER_CONFIRMED
    const updatedOrder = await prisma.communityOrder.update({
      where: { id: communityOrder.id },
      data: {
        status: CommunityOrderStatus.SUPPLIER_CONFIRMED,
      },
    });

    await prisma.auditEvent.create({
      data: {
        eventType: AuditEventType.SUPPLIER_CONFIRMED,
        actor: 'execution:supplier',
        entityType: 'CommunityOrder',
        entityId: communityOrder.id,
        metadata: {
          supplierId: communityOrder.supplierId,
          poReference: poResponse.poReference,
          confirmedDeliveryEta: poResponse.confirmedDeliveryEta,
        },
      },
    });

    return {
      success: true,
      communityOrderId: updatedOrder.id,
      po: poResponse,
      status: updatedOrder.status,
    };
  }

  /**
   * Initializes or advances physical delivery for a community order.
   */
  public async advanceCommunityDelivery(
    communityOrderId: string,
    targetStatus?: DeliveryStatus
  ): Promise<DeliveryTransitionResult> {
    // If not initialized, initialize first
    const existing = await prisma.delivery.findUnique({
      where: { communityOrderId },
    });

    if (!existing) {
      const snap = await this.deliverySimulator.initializeDelivery(
        communityOrderId,
        DeliveryStatus.PREPARING
      );
      if (!targetStatus || targetStatus === DeliveryStatus.PREPARING) {
        return {
          success: true,
          deliveryId: snap.deliveryId,
          communityOrderId,
          previousStatus: DeliveryStatus.PENDING,
          currentStatus: DeliveryStatus.PREPARING,
          fromStatus: DeliveryStatus.PENDING,
          toStatus: DeliveryStatus.PREPARING,
          isTerminal: false,
          trackingCode: snap.trackingCode,
          message: "Delivery initialized at 'PREPARING'",
          updatedAt: snap.updatedAt,
        };
      }
    }

    return this.deliverySimulator.advanceDelivery(communityOrderId, targetStatus);
  }

  /**
   * Retrieves current delivery snapshot.
   */
  public async getDeliveryStatus(communityOrderId: string): Promise<DeliveryStateSnapshot> {
    return this.deliverySimulator.getDeliveryStatus(communityOrderId);
  }

  /**
   * Orchestrates the complete end-to-end execution lifecycle:
   * 1. Payment execution for resident orders
   * 2. Supplier PO submission & confirmation
   * 3. Delivery progression to DELIVERED
   * 4. Resident quantity allocation
   * 5. Final multi-dimensional reconciliation
   */
  public async executeFullProcurementCycle(
    input: ExecuteFullCycleInput
  ): Promise<ExecuteFullCycleResult> {
    const communityOrder = await prisma.communityOrder.findUnique({
      where: { id: input.communityOrderId },
      include: {
        residentOrders: true,
        items: true,
      },
    });

    if (!communityOrder) {
      throw new ExecutionError(
        'COMMUNITY_ORDER_NOT_FOUND',
        `CommunityOrder '${input.communityOrderId}' not found`
      );
    }

    // 1. Execute payments for all contributing resident orders
    const paymentResults: ExecutePaymentResult[] = [];
    for (const ro of communityOrder.residentOrders) {
      const payRes = await this.executeResidentPayment({
        residentOrderId: ro.id,
        idempotencyKey: `PAY-EXEC-${ro.id}`,
      });
      paymentResults.push(payRes);
    }

    // 2. Submit & Confirm Supplier PO
    const supplierResult = await this.executeSupplierProcurement({
      communityOrderId: communityOrder.id,
      idempotencyKey: `SUPPLIER-PO-${communityOrder.id}`,
    });

    // 3. Initialize delivery & progress to DELIVERED
    await this.advanceCommunityDelivery(communityOrder.id, DeliveryStatus.PREPARING);
    await this.advanceCommunityDelivery(communityOrder.id, DeliveryStatus.DISPATCHED);
    await this.advanceCommunityDelivery(communityOrder.id, DeliveryStatus.OUT_FOR_DELIVERY);
    await this.advanceCommunityDelivery(communityOrder.id, DeliveryStatus.DELIVERED);

    const deliverySnapshot = await this.deliverySimulator.getDeliveryStatus(communityOrder.id);

    // 4. Perform resident allocations if provided or default 1:1
    if (input.allocations && input.allocations.length > 0) {
      await allocationService.allocateCommunityDelivery({
        communityOrderId: communityOrder.id,
        allocations: input.allocations,
      });
    }

    // 5. Execute final reconciliation
    const reconciliation = await reconciliationService.reconcileCommunityOrder(
      communityOrder.id
    );

    return {
      success: reconciliation.isReconciled,
      communityOrderId: communityOrder.id,
      payments: paymentResults,
      supplierPO: supplierResult.po,
      delivery: deliverySnapshot,
      reconciliation,
    };
  }
}

export const executionService = new ExecutionService();
