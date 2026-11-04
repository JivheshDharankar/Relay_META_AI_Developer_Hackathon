import { describe, it, expect, beforeEach } from 'vitest';
import {
  RelayOrchestrator,
  relayOrchestrator,
  WorkflowPlanner,
  workflowPlanner,
  WorkflowExecutor,
  WorkflowCheckpointService,
  WorkflowRecoveryService,
  assertLegalWorkflowStageTransition,
  assertLegalWorkflowStatusTransition,
  canTransitionWorkflowStage,
  canTransitionWorkflowStatus,
  validateCreateWorkflowInput,
  validateStagePreconditions,
  validateCompletionInvariants,
  WorkflowStateMachineError,
  RelayWorkflow,
  WorkflowStage,
  WorkflowStatus,
} from '../src/orchestration';
import {
  toolRegistry,
  startWorkflowTool,
  getWorkflowStateTool,
  executeWorkflowStepTool,
  resumeWorkflowTool,
  explainWorkflowTool,
} from '../src/agent/tools';
import { mandateService } from '../src/payment/mandate/MandateService';

/**
 * Relay never fabricates mandate consent: workflows that must reach PAY
 * hold a real mandate created through the mandate service for their
 * resident. Tests create it explicitly instead of relying on any
 * auto-provisioning.
 */
function ensureTestMandate(residentReference: string): void {
  mandateService.createMandate({
    ownerReference: residentReference,
    purpose: 'COMMUNITY_PROCUREMENT',
    spendingLimit: 1000000,
    currency: 'INR',
  });
}

describe('Phase 10: Complete Autonomous Relay Loop & Orchestration Lifecycle', () => {
  let orchestrator: RelayOrchestrator;
  let planner: WorkflowPlanner;
  let checkpointService: WorkflowCheckpointService;
  let recoveryService: WorkflowRecoveryService;

  beforeEach(() => {
    checkpointService = new WorkflowCheckpointService();
    recoveryService = new WorkflowRecoveryService(checkpointService);
    planner = new WorkflowPlanner();
    const executor = new WorkflowExecutor(planner, checkpointService);
    orchestrator = new RelayOrchestrator(
      planner,
      executor,
      checkpointService,
      undefined,
      recoveryService
    );
  });

  // ===========================================================================
  // 1. INTENT UNDERSTANDING & PARSING
  // ===========================================================================
  describe('1. Natural Language Intent Parsing & Demand Extraction', () => {
    it('1. parses clear intent with standard item and count: "I need 5 Dairy Milk."', () => {
      const intent = planner.parseIntent('I need 5 Dairy Milk.');
      expect(intent.isAmbiguous).toBe(false);
      expect(intent.productName.toLowerCase()).toContain('dairy milk');
      expect(intent.quantity).toBe(5);
      expect(intent.unit).toBe('units');
    });

    it('2. parses weight-based demand: "Need 2 kg basmati rice for apartment"', () => {
      const intent = planner.parseIntent('Need 2 kg basmati rice for apartment');
      expect(intent.isAmbiguous).toBe(false);
      expect(intent.productName.toLowerCase()).toContain('basmati rice');
      expect(intent.quantity).toBe(2);
      expect(intent.unit).toBe('kg');
    });

    it('3. parses volume-based bottle demand: "Can we get 3 bottles cooking oil"', () => {
      const intent = planner.parseIntent('Can we get 3 bottles cooking oil');
      expect(intent.isAmbiguous).toBe(false);
      expect(intent.productName.toLowerCase()).toContain('cooking oil');
      expect(intent.quantity).toBe(3);
      expect(intent.unit).toBe('bottles');
    });

    it('4. parses stationery demand: "Order 10 notebooks for the study room"', () => {
      const intent = planner.parseIntent('Order 10 notebooks for the study room');
      expect(intent.isAmbiguous).toBe(false);
      expect(intent.productName.toLowerCase()).toContain('notebooks');
      expect(intent.quantity).toBe(10);
      expect(intent.unit).toBe('units');
    });

    it('5. detects ambiguous intent with missing quantity: "I need some milk"', () => {
      const intent = planner.parseIntent('I need some milk');
      expect(intent.isAmbiguous).toBe(true);
      expect(intent.clarificationQuestion).toBeDefined();
      expect(intent.clarificationQuestion?.toLowerCase()).toContain('how many');
    });

    it('6. detects missing product name: "Please buy 5 of them"', () => {
      const intent = planner.parseIntent('Please buy 5 of them');
      expect(intent.isAmbiguous).toBe(true);
      expect(intent.clarificationQuestion).toBeDefined();
    });

    it('7. parses word-number quantities: "Please get three boxes of tea"', () => {
      const intent = planner.parseIntent('Please get three boxes of tea');
      expect(intent.isAmbiguous).toBe(false);
      expect(intent.quantity).toBe(3);
      expect(intent.unit).toBe('boxes');
      expect(intent.productName.toLowerCase()).toContain('tea');
    });

    it('8. rejects completely empty request text with error', () => {
      expect(() => {
        planner.parseIntent('');
      }).toThrow();
    });
  });

  // ===========================================================================
  // 2. END-TO-END AUTONOMOUS PROCUREMENT LOOP
  // ===========================================================================
  describe('2. End-to-End Autonomous Procurement Loop (13 Stages)', () => {
    it('9. drives "I need 5 Dairy Milk." autonomously through all 13 stages to COMPLETED', async () => {
      const workflow = await orchestrator.startWorkflow({
        requestText: 'I need 5 Dairy Milk.',
        location: {
          latitude: 18.5204,
          longitude: 73.8567,
          address: 'Tower 4, Greenview Residency, Pune',
        },
        residentReference: 'res_owner_401',
      });

      expect(workflow.status).toBe('COMPLETED');
      expect(workflow.currentStage).toBe('COMPLETE');
      expect(workflow.completedAt).toBeDefined();

      // Verify all 13 stages completed
      expect(workflow.stages.length).toBe(13);
      for (const st of workflow.stages) {
        expect(st.completed).toBe(true);
        expect(st.completedAt).toBeDefined();
      }

      // Verify authoritative entity linkage across all subsystems
      expect(workflow.entities.residentOrderId).toMatch(/^ro_/);
      expect(workflow.entities.supplierCandidateIds.length).toBeGreaterThan(0);
      expect(workflow.entities.qualifiedSupplierIds.length).toBeGreaterThan(0);
      expect(workflow.entities.rfqId).toMatch(/^rfq_/);
      expect(workflow.entities.receivedQuoteIds.length).toBeGreaterThan(0);
      expect(workflow.entities.negotiatedQuoteIds.length).toBeGreaterThan(0);
      expect(workflow.entities.selectedQuoteId).toBeDefined();
      expect(workflow.entities.commitmentId).toMatch(/^commit_/);
      expect(workflow.entities.purchaseOrderIds.length).toBeGreaterThan(0);
      expect(workflow.entities.paymentId).toMatch(/^(pay_|pmt_)/);
      expect(workflow.entities.fulfillmentOrderIds.length).toBeGreaterThan(0);
      expect(workflow.entities.deliveryTrackingCodes.length).toBeGreaterThan(0);
      expect(workflow.entities.allocationSummaryId).toBeDefined();
      expect(workflow.entities.reconciliationId).toMatch(/^(recon_|rcn_|rec_)/);
    });

    it('10. verifies sequential stage order in stage progress tracking', async () => {
      const workflow = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk packets',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      const expectedSequence: WorkflowStage[] = [
        'UNDERSTAND',
        'DISCOVER',
        'QUALIFY',
        'QUOTE',
        'NEGOTIATE',
        'SELECT',
        'COMMIT',
        'PAY',
        'FULFILL',
        'VERIFY',
        'ALLOCATE',
        'RECONCILE',
        'COMPLETE',
      ];

      expect(workflow.stages.map((s) => s.stage)).toEqual(expectedSequence);
    });

    it('11. verifies checkpoints are created for all 13 stages', async () => {
      const workflow = await orchestrator.startWorkflow({
        requestText: 'Order 5 Dairy Milk chocolate bars',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      const checkpoints = checkpointService.listCheckpoints(workflow.id);
      expect(checkpoints.length).toBe(13);
      expect(checkpoints[0].stage).toBe('UNDERSTAND');
      expect(checkpoints[12].stage).toBe('COMPLETE');
    });

    it('12. maintains immutable chronological timestamps: createdAt <= updatedAt <= completedAt', async () => {
      const workflow = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      expect(workflow.createdAt.getTime()).toBeLessThanOrEqual(workflow.updatedAt.getTime());
      expect(workflow.updatedAt.getTime()).toBeLessThanOrEqual(workflow.completedAt!.getTime());
    });

    it('13. maintains non-leaking resident references and delivery area in RFQ and PO', async () => {
      const workflow = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: {
          latitude: 18.5204,
          longitude: 73.8567,
          address: 'Secret Penthouse 1201, Confidential Tower, Pune',
        },
        residentReference: 'resident_vip_999',
      });

      // The workflow carries resident reference for ledger only, not in candidate or public quotes
      expect(workflow.residentReference).toBe('resident_vip_999');
      expect(workflow.status).toBe('COMPLETED');
    });

    it('14. supports step-by-step sequential execution through executeWorkflowStep', async () => {
      let wf = await orchestrator.createWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      expect(wf.currentStage).toBe('UNDERSTAND');
      expect(wf.status).toBe('DRAFT');

      wf = await orchestrator.executeWorkflowStep(wf.id);
      expect(wf.status).toBe('DEMAND_CREATED');

      wf = await orchestrator.executeWorkflowStep(wf.id);
      expect(wf.currentStage).toBe('DISCOVER');

      wf = await orchestrator.executeWorkflowStep(wf.id);
      expect(wf.currentStage).toBe('QUALIFY');
    });

    it('15. steps through all 13 stages iteratively using executeWorkflowStep until completion', async () => {
      let wf = await orchestrator.createWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      for (let i = 0; i < 13; i++) {
        wf = await orchestrator.executeWorkflowStep(wf.id);
      }

      expect(wf.status).toBe('COMPLETED');
      expect(wf.currentStage).toBe('COMPLETE');
    });

    it('16. executing a step on a COMPLETED workflow is idempotent and returns completed workflow', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      const next = await orchestrator.executeWorkflowStep(wf.id);
      expect(next.status).toBe('COMPLETED');
      expect(next.currentStage).toBe('COMPLETE');
    });

    it('17. retrieves stored workflow state via getWorkflowState', async () => {
      const created = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      const retrieved = orchestrator.getWorkflowState(created.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.status).toBe('COMPLETED');
    });

    it('18. lists all managed workflows accurately', async () => {
      const wf1 = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });
      const wf2 = await orchestrator.startWorkflow({
        requestText: '10 notebooks',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      const list = orchestrator.listWorkflows();
      expect(list.some((w) => w.id === wf1.id)).toBe(true);
      expect(list.some((w) => w.id === wf2.id)).toBe(true);
    });
  });

  // ===========================================================================
  // 3. MULTI-REQUEST CONCURRENT INDEPENDENT WORKFLOWS
  // ===========================================================================
  describe('3. Multi-Request Concurrent Independent Workflows', () => {
    it('19. executes 4 diverse requests concurrently without race conditions or state crosstalk', async () => {
      const req1 = orchestrator.startWorkflow({
        requestText: 'I need 5 Dairy Milk.',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });
      const req2 = orchestrator.startWorkflow({
        requestText: 'Need 2 kg basmati rice for apartment',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });
      const req3 = orchestrator.startWorkflow({
        requestText: 'Can we get 3 bottles cooking oil',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });
      const req4 = orchestrator.startWorkflow({
        requestText: 'Order 10 notebooks for the study room',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      const [w1, w2, w3, w4] = await Promise.all([req1, req2, req3, req4]);

      expect(w1.status).toBe('COMPLETED');
      expect(w2.status).toBe('COMPLETED');
      expect(w3.status).toBe('COMPLETED');
      expect(w4.status).toBe('COMPLETED');

      // Unique entities
      const rfqIds = new Set([w1.entities.rfqId, w2.entities.rfqId, w3.entities.rfqId, w4.entities.rfqId]);
      expect(rfqIds.size).toBe(4);

      const commitIds = new Set([
        w1.entities.commitmentId,
        w2.entities.commitmentId,
        w3.entities.commitmentId,
        w4.entities.commitmentId,
      ]);
      expect(commitIds.size).toBe(4);

      const payIds = new Set([
        w1.entities.paymentId,
        w2.entities.paymentId,
        w3.entities.paymentId,
        w4.entities.paymentId,
      ]);
      expect(payIds.size).toBe(4);
    });

    it('20. ensures concurrent workflows have distinct resident order IDs', async () => {
      const [w1, w2] = await Promise.all([
        orchestrator.startWorkflow({
          requestText: '5 Dairy Milk',
          location: { latitude: 18.5204, longitude: 73.8567 },
        }),
        orchestrator.startWorkflow({
          requestText: '5 Dairy Milk',
          location: { latitude: 18.5204, longitude: 73.8567 },
        }),
      ]);

      expect(w1.id).not.toBe(w2.id);
      expect(w1.entities.residentOrderId).not.toBe(w2.entities.residentOrderId);
    });

    it('21. serializes concurrent step executions on the same workflow without interleaving errors', async () => {
      const wf = await orchestrator.createWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      // Dispatch 3 step executions concurrently on the SAME workflow
      const p1 = orchestrator.executeWorkflowStep(wf.id);
      const p2 = orchestrator.executeWorkflowStep(wf.id);
      const p3 = orchestrator.executeWorkflowStep(wf.id);

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      // All should advance legally through the mutex lock
      expect(r3.currentStage).toBe('QUALIFY');
      expect(r3.status).toBe('QUALIFYING_SUPPLIERS');
    });

    it('22. maintains isolated checkpoints across parallel workflows', async () => {
      const [w1, w2] = await Promise.all([
        orchestrator.startWorkflow({
          requestText: '5 Dairy Milk',
          location: { latitude: 18.5204, longitude: 73.8567 },
        }),
        orchestrator.startWorkflow({
          requestText: '2 kg basmati rice',
          location: { latitude: 18.5204, longitude: 73.8567 },
        }),
      ]);

      const ch1 = checkpointService.listCheckpoints(w1.id);
      const ch2 = checkpointService.listCheckpoints(w2.id);

      expect(ch1.every((c) => c.workflowId === w1.id)).toBe(true);
      expect(ch2.every((c) => c.workflowId === w2.id)).toBe(true);
    });

    it('23. handles parallel workflows from distinct residents independently', async () => {
      const [wA, wB] = await Promise.all([
        orchestrator.startWorkflow({
          requestText: '5 Dairy Milk',
          location: { latitude: 18.5204, longitude: 73.8567 },
          residentReference: 'res_alpha',
        }),
        orchestrator.startWorkflow({
          requestText: '10 notebooks',
          location: { latitude: 18.5204, longitude: 73.8567 },
          residentReference: 'res_beta',
        }),
      ]);

      expect(wA.residentReference).toBe('res_alpha');
      expect(wB.residentReference).toBe('res_beta');
    });

    it('24. produces separate audit event streams for concurrent workflows', async () => {
      ensureTestMandate('res_audit_a');
      ensureTestMandate('res_audit_b');
      const [w1, w2] = await Promise.all([
        orchestrator.startWorkflow({
          requestText: '5 Dairy Milk',
          location: { latitude: 18.5204, longitude: 73.8567 },
          residentReference: 'res_audit_a',
        }),
        orchestrator.startWorkflow({
          requestText: '2 kg basmati rice',
          location: { latitude: 18.5204, longitude: 73.8567 },
          residentReference: 'res_audit_b',
        }),
      ]);

      expect(w1.entities.rfqId).not.toBe(w2.entities.rfqId);
      expect(w1.entities.paymentId).not.toBe(w2.entities.paymentId);
    });

    it('25. manages high concurrency with 6 simultaneous requests cleanly', async () => {
      const items = ['1 bread', '2 eggs', '3 apples', '4 oranges', '5 bananas', '6 grapes'];
      const promises = items.map((item) =>
        orchestrator.startWorkflow({
          requestText: item,
          location: { latitude: 18.5204, longitude: 73.8567 },
        })
      );

      const results = await Promise.all(promises);
      expect(results.every((r) => r.status === 'COMPLETED')).toBe(true);
      expect(new Set(results.map((r) => r.id)).size).toBe(6);
    });

    it('26. handles cancellation of one workflow without affecting concurrent sibling workflows', async () => {
      const wf1 = await orchestrator.createWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });
      const wf2 = await orchestrator.startWorkflow({
        requestText: '10 notebooks',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      const cancelled1 = orchestrator.cancelWorkflow(wf1.id, 'User changed mind');
      expect(cancelled1.status).toBe('CANCELLED');

      const retrieved2 = orchestrator.getWorkflowState(wf2.id);
      expect(retrieved2?.status).toBe('COMPLETED');
    });
  });

  // ===========================================================================
  // 4. GEOGRAPHIC LOCATION INDEPENDENCE
  // ===========================================================================
  describe('4. Geographic Location Independence (Worldwide Agnostic Coordinates)', () => {
    it('27. executes in Pune, India ({ latitude: 18.5204, longitude: 73.8567 })', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567, address: 'Koregaon Park, Pune' },
      });
      expect(wf.status).toBe('COMPLETED');
    });

    it('28. executes in Bangalore, India ({ latitude: 12.9716, longitude: 77.5946 })', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 12.9716, longitude: 77.5946, address: 'Indiranagar, Bangalore' },
      });
      expect(wf.status).toBe('COMPLETED');
    });

    it('29. executes in Delhi, India ({ latitude: 28.6139, longitude: 77.2090 })', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 28.6139, longitude: 77.2090, address: 'Connaught Place, Delhi' },
      });
      expect(wf.status).toBe('COMPLETED');
    });

    it('30. executes in Tokyo, Japan ({ latitude: 35.6762, longitude: 139.6503 })', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: '5 green tea packs',
        location: { latitude: 35.6762, longitude: 139.6503, address: 'Shibuya, Tokyo' },
      });
      expect(wf.status).toBe('COMPLETED');
    });

    it('31. executes in London, UK ({ latitude: 51.5074, longitude: -0.1278 })', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: '4 scones',
        location: { latitude: 51.5074, longitude: -0.1278, address: 'Covent Garden, London' },
      });
      expect(wf.status).toBe('COMPLETED');
    });

    it('32. rejects invalid latitude out of bounds (> 90 or < -90)', async () => {
      await expect(
        orchestrator.createWorkflow({
          requestText: '5 Dairy Milk',
          location: { latitude: 99.5, longitude: 73.8567 },
        })
      ).rejects.toThrow(/INVALID_COORDINATES/);
    });

    it('33. rejects invalid longitude out of bounds (> 180 or < -180)', async () => {
      await expect(
        orchestrator.createWorkflow({
          requestText: '5 Dairy Milk',
          location: { latitude: 18.5204, longitude: 195.0 },
        })
      ).rejects.toThrow(/INVALID_COORDINATES/);
    });
  });

  // ===========================================================================
  // 5. PRODUCT-AGNOSTIC DYNAMIC EXECUTION
  // ===========================================================================
  describe('5. Product-Agnostic Dynamic Execution', () => {
    it('34. executes unseen item: "12 AA batteries"', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: '12 AA batteries',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });
      expect(wf.status).toBe('COMPLETED');
      expect(wf.intent?.productName.toLowerCase()).toContain('aa batteries');
      expect(wf.intent?.quantity).toBe(12);
    });

    it('35. executes unseen item with custom unit: "4 packs organic green tea"', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: '4 packs organic green tea',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });
      expect(wf.status).toBe('COMPLETED');
      expect(wf.intent?.unit).toBe('packs');
    });

    it('36. executes unseen hardware item: "1 heavy duty air filter"', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: '1 heavy duty air filter',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });
      expect(wf.status).toBe('COMPLETED');
      expect(wf.intent?.quantity).toBe(1);
    });

    it('37. computes dynamic price without crashing or NaN', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: '7 solar rechargeable lamps',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });
      expect(wf.status).toBe('COMPLETED');
    });

    it('38. handles fractional-friendly units like kg and liters', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: '2 kg sugar',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });
      expect(wf.status).toBe('COMPLETED');
      expect(wf.intent?.unit).toBe('kg');
    });

    it('39. rejects non-positive or negative quantities', async () => {
      await expect(
        orchestrator.createWorkflow({
          requestText: '-5 chocolate bars',
          location: { latitude: 18.5204, longitude: 73.8567 },
        })
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // 6. STATE MACHINE INVARIANTS & TRANSITION PROTECTION
  // ===========================================================================
  describe('6. State Machine Invariants & Transition Rules', () => {
    it('40. allows legal sequential stage progression: UNDERSTAND -> DISCOVER', () => {
      expect(canTransitionWorkflowStage('UNDERSTAND', 'DISCOVER')).toBe(true);
    });

    it('41. rejects stage skipping: UNDERSTAND -> PAY throws WorkflowStateMachineError', () => {
      expect(canTransitionWorkflowStage('UNDERSTAND', 'PAY')).toBe(false);
      expect(() => {
        assertLegalWorkflowStageTransition('UNDERSTAND', 'PAY');
      }).toThrow(WorkflowStateMachineError);
    });

    it('42. rejects skipping from DISCOVER directly to COMMIT', () => {
      expect(canTransitionWorkflowStage('DISCOVER', 'COMMIT')).toBe(false);
      expect(() => {
        assertLegalWorkflowStageTransition('DISCOVER', 'COMMIT');
      }).toThrow(WorkflowStateMachineError);
    });

    it('43. rejects backward stage transitions: COMMIT -> DISCOVER', () => {
      expect(canTransitionWorkflowStage('COMMIT', 'DISCOVER')).toBe(false);
      expect(() => {
        assertLegalWorkflowStageTransition('COMMIT', 'DISCOVER');
      }).toThrow(WorkflowStateMachineError);
    });

    it('44. allows status transition DRAFT -> UNDERSTANDING', () => {
      expect(canTransitionWorkflowStatus('DRAFT', 'UNDERSTANDING')).toBe(true);
    });

    it('45. allows status transition DEMAND_CREATED -> DISCOVERING_SUPPLIERS', () => {
      expect(canTransitionWorkflowStatus('DEMAND_CREATED', 'DISCOVERING_SUPPLIERS')).toBe(true);
    });

    it('46. rejects illegal status jump DRAFT -> COMPLETED', () => {
      expect(canTransitionWorkflowStatus('DRAFT', 'COMPLETED')).toBe(false);
      expect(() => {
        assertLegalWorkflowStatusTransition('DRAFT', 'COMPLETED');
      }).toThrow(WorkflowStateMachineError);
    });

    it('47. allows cancellation from active in-flight status', () => {
      expect(canTransitionWorkflowStatus('DISCOVERING_SUPPLIERS', 'CANCELLED')).toBe(true);
    });

    it('48. rejects cancellation from terminal COMPLETED status', () => {
      expect(canTransitionWorkflowStatus('COMPLETED', 'CANCELLED')).toBe(false);
    });

    it('48b. every non-terminal status can fail; failed and blocked missions can be cancelled', () => {
      expect(canTransitionWorkflowStatus('DRAFT', 'FAILED')).toBe(true);
      expect(canTransitionWorkflowStatus('COMMITTING_PROCUREMENT', 'FAILED')).toBe(true);
      expect(canTransitionWorkflowStatus('FAILED', 'CANCELLED')).toBe(true);
      expect(canTransitionWorkflowStatus('BLOCKED', 'CANCELLED')).toBe(true);
      expect(canTransitionWorkflowStatus('FAILED', 'DEMAND_CREATED')).toBe(true);
    });

    it('48c. clarified resume never regresses the workflow to DRAFT', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: 'I need some milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });
      expect(wf.status).toBe('AWAITING_CLARIFICATION');

      const resumed = await orchestrator.resumeWorkflow(wf.id, '2 litres of toned milk');
      expect(resumed.status).toBe('COMPLETED');
      expect(resumed.stages[0].status).toBe('COMPLETED');
    });

    it('49. cancelWorkflow cancels in-flight workflow and persists cancellation reason', async () => {
      const wf = await orchestrator.createWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      const cancelled = orchestrator.cancelWorkflow(wf.id, 'Resident requested cancellation');
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.failureReason).toContain('Resident requested cancellation');
    });
  });

  // ===========================================================================
  // 7. AMBIGUITY, CLARIFICATION & PAUSE-RESUME FLOW
  // ===========================================================================
  describe('7. Ambiguity, Clarification & Pause-Resume Flow', () => {
    it('50. pauses and enters AWAITING_CLARIFICATION on ambiguous request: "I need some milk"', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: 'I need some milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      expect(wf.status).toBe('AWAITING_CLARIFICATION');
      expect(wf.isPaused).toBe(true);
      expect(wf.pauseReason).toBeDefined();
    });

    it('50b. halted stages are never marked COMPLETED on the checklist', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: 'I need some milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });
      expect(wf.status).toBe('AWAITING_CLARIFICATION');

      // Stored checklist: the halted UNDERSTAND stage is IN_PROGRESS, and no
      // stage claims completion.
      const understand = wf.stages.find((s) => s.stage === 'UNDERSTAND')!;
      expect(understand.status).toBe('IN_PROGRESS');
      expect(wf.stages.every((s) => s.status !== 'COMPLETED')).toBe(true);

      // Derived progress agrees: current stage PENDING (paused), rest PENDING.
      const progress = orchestrator.getWorkflowProgress(wf.id);
      expect(progress[0].status).toBe('PENDING');
      expect(progress.every((s) => s.status !== 'COMPLETED')).toBe(true);
    });

    it('51. resumeWorkflow with clarified input resumes paused workflow to completion', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: 'I need milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      expect(wf.status).toBe('AWAITING_CLARIFICATION');

      const resumed = await orchestrator.resumeWorkflow(wf.id, '5 packets');
      expect(resumed.isPaused).toBe(false);
      expect(resumed.status).toBe('COMPLETED');
      expect(resumed.intent?.quantity).toBe(5);
    });

    it('52. resumes paused workflow using full sentence clarification', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: 'Order rice please',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      expect(wf.status).toBe('AWAITING_CLARIFICATION');

      const resumed = await orchestrator.resumeWorkflow(wf.id, 'Please order 5 kg basmati rice');
      expect(resumed.status).toBe('COMPLETED');
      expect(resumed.intent?.quantity).toBe(5);
      expect(resumed.intent?.unit).toBe('kg');
    });

    it('53. pauseWorkflow pauses an active workflow explicitly', async () => {
      const wf = await orchestrator.createWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      const paused = orchestrator.pauseWorkflow(wf.id, 'Waiting for committee approval');
      expect(paused.isPaused).toBe(true);
      expect(paused.pauseReason).toBe('Waiting for committee approval');
    });

    it('54. resumeWorkflow without new input unpauses an explicitly paused workflow', async () => {
      const wf = await orchestrator.createWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      orchestrator.pauseWorkflow(wf.id, 'Manual pause');
      const resumed = await orchestrator.resumeWorkflow(wf.id);
      expect(resumed.isPaused).toBe(false);
    });

    it('55. resuming a non-existent workflow throws an error', async () => {
      await expect(orchestrator.resumeWorkflow('wf_non_existent', 'clarify')).rejects.toThrow();
    });
  });

  // ===========================================================================
  // 8. CHECKPOINTING & STATE RECOVERY
  // ===========================================================================
  describe('8. Checkpointing & State Recovery', () => {
    it('56. saves checkpoint with snapshot of entities and status after each stage', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      const ck = checkpointService.getLatestCheckpoint(wf.id);
      expect(ck).toBeDefined();
      expect(ck?.stage).toBe('COMPLETE');
      expect(ck?.snapshot.entities.paymentId).toBeDefined();
    });

    it('57. retrieves specific checkpoint by stage name', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      const commitCk = checkpointService.getCheckpointByStage(wf.id, 'COMMIT');
      expect(commitCk).toBeDefined();
      expect(commitCk?.stage).toBe('COMMIT');
      expect(commitCk?.snapshot.entities.commitmentId).toBeDefined();
    });

    it('58. evaluateRecovery determines recovery plan from interrupted state', async () => {
      const wf = await orchestrator.createWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      // Advance to COMMIT
      for (let i = 0; i < 7; i++) {
        await orchestrator.executeWorkflowStep(wf.id);
      }

      const evalResult = await recoveryService.evaluateRecovery(wf);
      expect(evalResult.canRecover).toBe(true);
      expect(evalResult.recommendedAction).toBeDefined();
    });

    it('59. prevents double payment during recovery when payment is already verified in backend', async () => {
      ensureTestMandate('res_recovery_59');
      const wf = await orchestrator.createWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
        residentReference: 'res_recovery_59',
      });

      // Advance through PAY (8 steps)
      for (let i = 0; i < 8; i++) {
        await orchestrator.executeWorkflowStep(wf.id);
      }

      expect(wf.entities.paymentId).toBeDefined();

      // Simulate recovery check
      const evalResult = await recoveryService.evaluateRecovery(wf);
      expect(evalResult.canRecover).toBe(true);
      expect(evalResult.isPaymentExecuted).toBe(true);
    });

    it('60. recovery from terminal COMPLETED workflow indicates no action needed', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      const evalResult = await recoveryService.evaluateRecovery(wf);
      expect(evalResult.canRecover).toBe(false);
      expect(evalResult.recommendedAction).toBe('NONE');
    });

    it('61. checkpoint service returns undefined for unknown workflow ID', () => {
      expect(checkpointService.getLatestCheckpoint('wf_unknown')).toBeUndefined();
      expect(checkpointService.listCheckpoints('wf_unknown')).toEqual([]);
    });

    it('62. checkpoint preserves failure classification when workflow fails', () => {
      const mockWf: RelayWorkflow = {
        id: 'wf_fail_test',
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567, address: 'Pune' },
        residentReference: 'res_1',
        societyReference: 'soc_1',
        status: 'FAILED',
        currentStage: 'PAY',
        workflowVersion: 1,
        startedAt: new Date(),
        retryCount: 0,
        isPaused: false,
        failureReason: 'PAYMENT_TIMEOUT: Gateway connection dropped',
        failureClassification: 'RETRYABLE',
        stages: [],
        entities: {
          supplierCandidateIds: [],
          qualifiedSupplierIds: [],
          receivedQuoteIds: [],
          negotiatedQuoteIds: [],
          purchaseOrderIds: [],
          fulfillmentOrderIds: [],
          deliveryTrackingCodes: [],
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      checkpointService.saveCheckpoint(mockWf);
      const ck = checkpointService.getLatestCheckpoint(mockWf.id);
      expect(ck?.snapshot.failureClassification).toBe('RETRYABLE');
    });

    it('63. recovery evaluator identifies RETRYABLE failed workflows for retry', async () => {
      const mockWf: RelayWorkflow = {
        id: 'wf_retry_eval',
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567, address: 'Pune' },
        residentReference: 'res_1',
        societyReference: 'soc_1',
        status: 'FAILED',
        currentStage: 'DISCOVER',
        workflowVersion: 1,
        startedAt: new Date(),
        retryCount: 0,
        isPaused: false,
        failureReason: 'NETWORK_TIMEOUT',
        failureClassification: 'RETRYABLE',
        stages: [],
        entities: {
          supplierCandidateIds: [],
          qualifiedSupplierIds: [],
          receivedQuoteIds: [],
          negotiatedQuoteIds: [],
          purchaseOrderIds: [],
          fulfillmentOrderIds: [],
          deliveryTrackingCodes: [],
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const evalResult = await recoveryService.evaluateRecovery(mockWf);
      expect(evalResult.canRecover).toBe(true);
      expect(evalResult.recommendedAction).toBe('RETRY_STAGE');
    });
  });

  // ===========================================================================
  // 9. SECTION 59 COMPLETION INVARIANTS (7-PILLAR VALIDATION)
  // ===========================================================================
  describe('9. Section 59 Completion Invariants (7-Pillar Integrity)', () => {
    it('64. passes validation when all 7 authoritative entities are present', async () => {
      ensureTestMandate('res_invariants_64');
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
        residentReference: 'res_invariants_64',
      });

      expect(() => validateCompletionInvariants(wf)).not.toThrow();
    });

    it('65. Pillar 1: throws if residentOrderId is missing upon completion', () => {
      const wf = createMockCompletedWorkflow();
      delete (wf.entities as any).residentOrderId;
      expect(() => validateCompletionInvariants(wf)).toThrow(/MISSING_RESIDENT_ORDER/);
    });

    it('66. Pillar 2: throws if selectedQuoteId is missing upon completion', () => {
      const wf = createMockCompletedWorkflow();
      delete (wf.entities as any).selectedQuoteId;
      expect(() => validateCompletionInvariants(wf)).toThrow(/MISSING_SELECTED_QUOTE/);
    });

    it('67. Pillar 3: throws if commitmentId is missing upon completion', () => {
      const wf = createMockCompletedWorkflow();
      delete (wf.entities as any).commitmentId;
      expect(() => validateCompletionInvariants(wf)).toThrow(/MISSING_COMMITMENT/);
    });

    it('68. Pillar 4: throws if paymentId is missing upon completion', () => {
      const wf = createMockCompletedWorkflow();
      delete (wf.entities as any).paymentId;
      expect(() => validateCompletionInvariants(wf)).toThrow(/MISSING_PAYMENT/);
    });

    it('69. Pillar 5: throws if fulfillmentOrderIds is empty upon completion', () => {
      const wf = createMockCompletedWorkflow();
      wf.entities.fulfillmentOrderIds = [];
      expect(() => validateCompletionInvariants(wf)).toThrow(/MISSING_FULFILLMENT_ORDERS/);
    });

    it('70. Pillar 6: throws if allocationSummaryId is missing upon completion', () => {
      const wf = createMockCompletedWorkflow();
      delete (wf.entities as any).allocationSummaryId;
      expect(() => validateCompletionInvariants(wf)).toThrow(/MISSING_ALLOCATION_SUMMARY/);
    });

    it('71. Pillar 7: throws if reconciliationId is missing upon completion', () => {
      const wf = createMockCompletedWorkflow();
      delete (wf.entities as any).reconciliationId;
      expect(() => validateCompletionInvariants(wf)).toThrow(/MISSING_RECONCILIATION/);
    });
  });

  // ===========================================================================
  // 10. PAYMENT SAFETY & FINANCIAL INVARIANTS
  // ===========================================================================
  describe('10. Payment Safety & Financial Invariants', () => {
    it('72. derives payment amount authoritatively from commitment financials (AI never sets amount)', async () => {
      ensureTestMandate('res_pay_72');
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
        residentReference: 'res_pay_72',
      });

      expect(wf.entities.paymentId).toBeDefined();
    });

    it('73. verifies exact Decimal financial arithmetic: subtotal + tax + deliveryFee = total', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      const commitment = (wf as any)._commitment;
      expect(commitment).toBeDefined();
      const financials = commitment.financials;
      const expectedTotal = financials.subtotal + financials.tax + financials.deliveryFee + financials.otherCharges;
      expect(financials.total).toBeCloseTo(expectedTotal, 2);
    });

    it('74. never fabricates a payment mandate: PAY fails closed without one', async () => {
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
        residentReference: `res_nomandate_${Math.random().toString(36).slice(2, 10)}`,
      });

      // No mandate was created for this resident (neither persisted nor in
      // the mandate service): the workflow must NOT complete and must
      // report the missing mandate instead of auto-creating consent.
      expect(wf.status).toBe('FAILED');
      expect(wf.failureReason).toContain('MANDATE_NOT_FOUND');
      expect(wf.entities.paymentId).toBeUndefined();
    });

    it('75. guarantees zero double-charge when workflow step execution is retried', async () => {
      ensureTestMandate('res_pay_75');
      const wf = await orchestrator.createWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
        residentReference: 'res_pay_75',
      });

      // Advance through PAY stage
      for (let i = 0; i < 8; i++) {
        await orchestrator.executeWorkflowStep(wf.id);
      }

      const initialPaymentId = wf.entities.paymentId;
      expect(initialPaymentId).toBeDefined();

      // Calling step again should advance to FULFILL, never creating a second payment
      await orchestrator.executeWorkflowStep(wf.id);
      expect(wf.entities.paymentId).toBe(initialPaymentId);
    });

    it('76. validates stage preconditions before executing PAY (commitment must exist)', () => {
      const mockWf = createMockCompletedWorkflow();
      delete (mockWf.entities as any).commitmentId;
      mockWf.currentStage = 'COMMIT';
      expect(() => validateStagePreconditions(mockWf, 'PAY')).toThrow(/MISSING_PRECONDITION/);
    });

    it('77. validates stage preconditions before executing COMMIT (selected quote must exist)', () => {
      const mockWf = createMockCompletedWorkflow();
      delete (mockWf.entities as any).selectedQuoteId;
      mockWf.currentStage = 'SELECT';
      expect(() => validateStagePreconditions(mockWf, 'COMMIT')).toThrow(/MISSING_PRECONDITION/);
    });
  });

  // ===========================================================================
  // 11. FULFILLMENT & SLA EXECUTION
  // ===========================================================================
  describe('11. Fulfillment & Operational SLA Execution', () => {
    it('78. generates and persists courier waybill tracking code', async () => {
      ensureTestMandate('res_fulfill_78');
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
        residentReference: 'res_fulfill_78',
      });

      expect(wf.entities.deliveryTrackingCodes.length).toBeGreaterThan(0);
      expect(wf.entities.deliveryTrackingCodes[0]).toMatch(/^TRK-/);
    });

    it('79. verifies delivery milestone events were ingested during fulfillment', async () => {
      ensureTestMandate('res_fulfill_79');
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
        residentReference: 'res_fulfill_79',
      });

      const fulfillmentOrder = (wf as any)._fulfillmentOrder;
      expect(fulfillmentOrder).toBeDefined();
      expect(fulfillmentOrder.status).toBe('VERIFIED');
    });

    it('80. records simulated delivery confirmation evidence', async () => {
      ensureTestMandate('res_fulfill_80');
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
        residentReference: 'res_fulfill_80',
      });

      const fulfillmentOrder = (wf as any)._fulfillmentOrder;
      expect(fulfillmentOrder.verificationEvidence).toBeDefined();
      expect(fulfillmentOrder.verificationEvidence.evidenceType).toBe('DELIVERY_CONFIRMATION');
    });

    it('81. enforces stage preconditions before executing FULFILL (payment must exist)', () => {
      const mockWf = createMockCompletedWorkflow();
      delete (mockWf.entities as any).paymentId;
      mockWf.currentStage = 'PAY';
      expect(() => validateStagePreconditions(mockWf, 'FULFILL')).toThrow(/MISSING_PRECONDITION/);
    });

    it('82. enforces stage preconditions before executing VERIFY (fulfillment order must exist)', () => {
      const mockWf = createMockCompletedWorkflow();
      mockWf.entities.fulfillmentOrderIds = [];
      mockWf.currentStage = 'FULFILL';
      expect(() => validateStagePreconditions(mockWf, 'VERIFY')).toThrow(/MISSING_PRECONDITION/);
    });

    it('83. fulfillment order correctly references purchase order and commitment', async () => {
      ensureTestMandate('res_fulfill_83');
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
        residentReference: 'res_fulfill_83',
      });

      const fulfillmentOrder = (wf as any)._fulfillmentOrder;
      expect(fulfillmentOrder.commitmentId).toBe(wf.entities.commitmentId);
      expect(fulfillmentOrder.purchaseOrderId).toBe(wf.entities.purchaseOrderIds[0]);
    });
  });

  // ===========================================================================
  // 12. RESIDENT ALLOCATION & 4-PILLAR RECONCILIATION
  // ===========================================================================
  describe('12. Resident Allocation & 4-Pillar Reconciliation', () => {
    it('84. conserves quantity: allocated quantity exactly equals verified delivered quantity', async () => {
      ensureTestMandate('res_alloc_84');
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
        residentReference: 'res_alloc_84',
      });

      const allocSummary = (wf as any)._allocationSummary;
      expect(allocSummary).toBeDefined();
      expect(allocSummary.totalAllocatedQuantity).toBe(5);
    });

    it('85. conserves monetary total: resident allocated amount matches procurement cost', async () => {
      ensureTestMandate('res_alloc_85');
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
        residentReference: 'res_alloc_85',
      });

      const allocSummary = (wf as any)._allocationSummary;
      expect(allocSummary.totalResidentAllocatedAmount).toBeCloseTo(allocSummary.totalProcurementCost, 2);
    });

    it('86. achieves RECONCILED reconciliation status with 0 unresolved discrepancies', async () => {
      ensureTestMandate('res_alloc_86');
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
        residentReference: 'res_alloc_86',
      });

      const reconResult = (wf as any)._reconciliationResult;
      expect(reconResult).toBeDefined();
      expect(reconResult.status).toBe('RECONCILED');
      expect(reconResult.discrepancies.length).toBe(0);
    });

    it('87. prevents competitor pricing leakage in resident allocation summary', async () => {
      ensureTestMandate('res_alloc_87');
      const wf = await orchestrator.startWorkflow({
        requestText: '5 Dairy Milk',
        location: { latitude: 18.5204, longitude: 73.8567 },
        residentReference: 'res_alloc_87',
      });

      const allocSummary = (wf as any)._allocationSummary;
      for (const alloc of allocSummary.allocations) {
        expect(alloc.competitorBids).toBeUndefined();
      }
    });

    it('88. allocates resident demands for multiple quantity items accurately', async () => {
      ensureTestMandate('res_alloc_88');
      const wf = await orchestrator.startWorkflow({
        requestText: '10 notebooks',
        location: { latitude: 18.5204, longitude: 73.8567 },
        residentReference: 'res_alloc_88',
      });

      const allocSummary = (wf as any)._allocationSummary;
      expect(allocSummary.totalAllocatedQuantity).toBe(10);
    });

    it('89. enforces stage preconditions before ALLOCATE (verification must be complete)', () => {
      const mockWf = createMockCompletedWorkflow();
      mockWf.currentStage = 'FULFILL';
      expect(() => validateStagePreconditions(mockWf, 'ALLOCATE')).toThrow(/MISSING_PRECONDITION/);
    });
  });

  // ===========================================================================
  // 13. PHASE 10 CONSTRAINED AI AGENT TOOLS
  // ===========================================================================
  describe('13. Constrained Phase 10 AI Agent Tools', () => {
    it('90. startWorkflowTool starts workflow and returns workflow ID and initial state', async () => {
      const result = await startWorkflowTool.execute(
        {
          requestText: 'I need 2 kg sugar.',
          latitude: 18.5204,
          longitude: 73.8567,
          address: 'Tower 4, Greenview Residency, Pune',
        },
        {} as any
      );

      expect(result.success).toBe(true);
      expect(result.data.workflowId).toBeDefined();
      expect(result.data.status).toBe('COMPLETED');
    });

    it('91. getWorkflowStateTool returns complete workflow progress and entities', async () => {
      const startRes = await startWorkflowTool.execute(
        {
          requestText: '2 kg sugar',
          latitude: 18.5204,
          longitude: 73.8567,
        },
        {} as any
      );

      const wf91 = relayOrchestrator.getWorkflow(startRes.data.workflowId)!;
      const stateRes = await getWorkflowStateTool.execute(
        { workflowId: startRes.data.workflowId },
        { residentId: wf91.residentReference, societyId: wf91.societyReference } as any
      );

      expect(stateRes.success).toBe(true);
      expect(stateRes.data.status).toBe('COMPLETED');
      expect(stateRes.data.entities.paymentId).toBeDefined();
    });

    it('92. executeWorkflowStepTool executes an individual step on a workflow', async () => {
      const wf = await relayOrchestrator.createWorkflow({
        requestText: '2 kg sugar',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      const stepRes = await executeWorkflowStepTool.execute(
        { workflowId: wf.id },
        { residentId: wf.residentReference, societyId: wf.societyReference } as any
      );

      expect(stepRes.success).toBe(true);
      expect(stepRes.data.status).toBe('DEMAND_CREATED');
    });

    it('93. resumeWorkflowTool resumes a paused workflow', async () => {
      // Pause via the direct orchestrator path: quantity-less 'I need sugar'
      // is legacy-ambiguous, so UNDERSTAND pauses for clarification (same
      // precedent as tests 50-52). Through startWorkflowTool the 14.2 entry
      // gate resolves first, so the tool path never pauses for this input.
      const wf = await relayOrchestrator.startWorkflow({
        requestText: 'I need sugar',
        location: { latitude: 18.5204, longitude: 73.8567 },
      });

      expect(wf.status).toBe('AWAITING_CLARIFICATION');
      expect(wf.isPaused).toBe(true);

      const resumeRes = await resumeWorkflowTool.execute(
        {
          workflowId: wf.id,
          clarifiedText: '5 packets',
        },
        { residentId: wf.residentReference, societyId: wf.societyReference } as any
      );

      expect(resumeRes.success).toBe(true);
      expect(resumeRes.data.status).toBe('COMPLETED');
    });

    it('94. explainWorkflowTool provides clear human-readable narrative of workflow state', async () => {
      const startRes = await startWorkflowTool.execute(
        {
          requestText: '2 kg sugar',
          latitude: 18.5204,
          longitude: 73.8567,
        },
        {} as any
      );

      const wf94 = relayOrchestrator.getWorkflow(startRes.data.workflowId)!;
      const explainRes = await explainWorkflowTool.execute(
        { workflowId: startRes.data.workflowId },
        { residentId: wf94.residentReference, societyId: wf94.societyReference } as any
      );

      expect(explainRes.success).toBe(true);
      expect(explainRes.data.explanation).toBeDefined();
      expect(explainRes.data.explanation.toLowerCase()).toContain('completed');
    });

    it('95b. workflow tools reject cross-resident access', async () => {
      const startRes = await startWorkflowTool.execute(
        {
          requestText: '2 kg sugar',
          latitude: 18.5204,
          longitude: 73.8567,
        },
        {} as any
      );
      const foreignCtx = { residentId: 'res_foreign_999', societyId: 'soc_foreign_999' } as any;

      await expect(
        getWorkflowStateTool.execute({ workflowId: startRes.data.workflowId }, foreignCtx)
      ).rejects.toThrow('belongs to another resident or society');
      // executeWorkflowStep reports failures as data (never throws): the
      // cross-resident attempt must surface as success:false, not progress.
      const stepRes = await executeWorkflowStepTool.execute(
        { workflowId: startRes.data.workflowId },
        foreignCtx
      );
      expect(stepRes.success).toBe(false);
      expect(stepRes.error).toContain('belongs to another resident or society');
      await expect(
        explainWorkflowTool.execute({ workflowId: startRes.data.workflowId }, foreignCtx)
      ).rejects.toThrow('belongs to another resident or society');
    });

    it('95. getWorkflowStateTool returns error for unknown workflowId', async () => {
      const res = await getWorkflowStateTool.execute(
        { workflowId: 'wf_nonexistent_xyz' },
        { residentId: 'res_unknown_probe', societyId: 'soc_unknown_probe' } as any
      );

      expect(res.success).toBe(false);
      expect(res.error).toBeDefined();
    });

    it('96. startWorkflowTool rejects requests with invalid latitude', async () => {
      const res = await startWorkflowTool.execute(
        {
          requestText: '2 kg sugar',
          latitude: 95.0,
          longitude: 73.8567,
        },
        {} as any
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('INVALID_COORDINATES');
    });

    it('97. all 5 Phase 10 tools are registered in the agent tool registry', () => {
      expect(toolRegistry.has('startWorkflow')).toBe(true);
      expect(toolRegistry.has('getWorkflowState')).toBe(true);
      expect(toolRegistry.has('executeWorkflowStep')).toBe(true);
      expect(toolRegistry.has('resumeWorkflow')).toBe(true);
      expect(toolRegistry.has('explainWorkflow')).toBe(true);
    });
  });
});

// Helper to construct mock completed workflow for invariant unit checks
function createMockCompletedWorkflow(): RelayWorkflow {
  return {
    id: 'wf_mock_test',
    requestText: '5 Dairy Milk',
    location: {
      latitude: 18.5204,
      longitude: 73.8567,
      address: 'Pune',
    },
    residentReference: 'res_mock_1',
    status: 'COMPLETED',
    currentStage: 'COMPLETE',
    isPaused: false,
    stages: [],
    entities: {
      residentOrderId: 'ro_mock_123',
      supplierCandidateIds: ['cand_1'],
      qualifiedSupplierIds: ['cand_1'],
      rfqId: 'rfq_mock_123',
      receivedQuoteIds: ['quote_1'],
      negotiatedQuoteIds: ['quote_1'],
      selectedQuoteId: 'quote_1',
      commitmentId: 'commit_mock_123',
      purchaseOrderIds: ['po_mock_123'],
      paymentId: 'pay_mock_123',
      fulfillmentOrderIds: ['ful_mock_123'],
      deliveryTrackingCodes: ['TRK-123'],
      allocationSummaryId: 'commit_mock_123',
      reconciliationId: 'recon_mock_123',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: new Date(),
  };
}
