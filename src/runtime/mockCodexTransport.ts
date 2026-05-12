import { EventEmitter } from "node:events";
import path from "node:path";
import { nanoid } from "nanoid";
import type { InitializeResponse, ServerNotification } from "@generated/app-server";
import type { ModelListResponse, ThreadReadResponse, ThreadResumeResponse, ThreadStartParams, ThreadStartResponse, TurnStartParams, TurnStartResponse } from "@generated/app-server/v2";
import type { CodexTransport, TransportEventMap } from "./codexTransport";

const MOCK_TURN_COMPLETION_DELAY_MS = 50;

const createMockInterfacePayload = (cwd: string): string =>
  JSON.stringify({
    overview: {
      summary: `${path.basename(cwd)} is a repository with an initialized interface generated from the mock Codex transport.`,
      architecture: "The mock transport treats the repository as a small app with a primary entry point and a conventional source folder.",
      whatProjectDoes: "The repository appears to contain application code plus its supporting manifests and scripts.",
      howItIsOrganized: "Source files live under src/, while project-level manifests and configuration files remain at the repository root.",
      importantToKnowFirst: "This interface was generated in mock mode for testing, so the prose is synthetic but structurally representative.",
      importantFiles: ["package.json", "src/index.ts"],
      subsystemSummaries: [
        {
          name: "Application code",
          summary: "Core implementation files live in src/ and contain the primary runtime behavior.",
          paths: ["src"]
        }
      ],
      dependencyHighlights: ["Manifest-driven dependencies are available from package metadata when present."],
      statisticsSummary: "Mock interface generation completed successfully.",
      recommendations: ["Review the generated overview and replace mock mode with live Codex access for production analysis."]
    },
    pathSummaries: [
      {
        relativePath: "src",
        pathKind: "directory",
        title: "src",
        purpose: "Contains the main implementation modules.",
        summary: "The source directory is the primary location for runtime code.",
        keySymbols: [],
        relatedFiles: ["src/index.ts"],
        confidence: 0.74
      },
      {
        relativePath: "src/index.ts",
        pathKind: "file",
        title: "index.ts",
        purpose: "Likely entry point for the sample repository.",
        summary: "This file looks like a top-level module that initializes or exports the core program behavior.",
        keySymbols: ["value"],
        relatedFiles: ["package.json"],
        confidence: 0.79
      }
    ]
  });

const createMockUltimateGoalPayload = (cwd: string): string =>
  JSON.stringify({
    summary: `Advance ${path.basename(cwd)} toward a production-ready, workflow-driven implementation.`,
    detailedIntent:
      "Preserve the repository's secure architecture, keep deterministic runtime boundaries intact, and steadily improve the product through explicit workflow cycles.",
    successCriteria: [
      "The project can move through recommendation, goal, coding, integrity, and merge stages with persisted workflow state.",
      "Architecture and security boundaries remain explicit and intact.",
      "Each cycle produces a scoped goal and deterministic validation before merge."
    ],
    constraints: [
      "Do not bypass typed IPC.",
      "Do not expose Node APIs in the renderer.",
      "Keep privileged repository operations in runtime or the main process."
    ],
    nonGoals: [
      "Do not implement fake full autonomy in a single pass.",
      "Do not replace the Codex app-server stdio transport."
    ],
    targetAudience: "Developers extending and operating the local workflow orchestrator.",
    qualityBar: "Clear, test-backed, security-preserving changes that establish a durable orchestration foundation."
  });

type MockRecommendationMode = "deliver" | "optimize" | "appeal";

const createMockRecommendationPayload = (cwd: string, objective: MockRecommendationMode = "deliver"): string => {
  const improvementMode = objective !== "deliver";
  const appealMode = objective === "appeal";
  return JSON.stringify({
    summary:
      appealMode
        ? `The repository under ${path.basename(cwd)} appears to have met the base goal, so the next cycle should be a final, bounded appeal pass focused on user-facing polish.`
        : objective === "optimize"
        ? `The repository under ${path.basename(cwd)} already has a working baseline, so the next cycle should focus on a small, high-confidence improvement. The options below stay intentionally narrow so one coding pass can polish the project cleanly.`
        : `The repository under ${path.basename(cwd)} is ready for a small, high-confidence next step. The options below stay intentionally narrow so a single coding pass can complete one recommendation and hand it cleanly to integrity.`,
    ultimateGoalProgress: {
      percentComplete: improvementMode ? 100 : 42,
      rationale: improvementMode
        ? "The base goal looks satisfied in mock mode, so optimize mode keeps searching for bounded follow-up improvements."
        : "The charter is established and the workflow is producing bounded next steps, but the project still has multiple implementation cycles left before the overall goal is complete."
    },
    ultimateGoalCompletion: {
      state: improvementMode ? "goal_satisfied" : "needs_more_work",
      rationale: improvementMode
        ? appealMode
          ? "The mock transport is treating the main goal as satisfied and is now recommending the final appeal pass."
          : "The mock transport is treating the main goal as satisfied and is now recommending improvement work."
        : "The mock transport is treating the Ultimate Goal as still in progress."
    },
    recommendations: [
      {
        title: improvementMode ? "Polish the visible workflow surfaces" : "Tighten the workflow stage transitions",
        summary: improvementMode
          ? "Make the workflow screens clearer and easier to scan without turning the task into a broad redesign."
          : "Make the stage handoff between recommendation, planning, coding, and integrity explicit and easier to reason about.",
        rationale: improvementMode
          ? appealMode
            ? "The final appeal pass should make the completed experience feel more polished before deliver-goal mode stops."
            : "Optimize mode should keep looking for practical improvements after the core flow works."
          : "The current loop is easier to stabilize if the orchestration state changes are small and well-bounded.",
        expectedImpact: improvementMode
          ? "This makes the product feel more polished and easier to operate."
          : "This reduces random workflow behavior and makes the next validation pass more predictable.",
        priority: "high",
        confidence: 0.95,
        estimatedScope: "small",
        riskLevel: "low",
        relatedPaths: improvementMode
          ? ["src/renderer/App.tsx", "src/renderer/styles.css"]
          : ["src/runtime/appService.ts", "src/shared/workflow.ts"]
      },
      {
        title: improvementMode ? "Trim avoidable workflow overhead" : "Improve the agent status explanations",
        summary: improvementMode
          ? "Reduce unnecessary work in the workflow loop and tighten the information the UI renders every cycle."
          : "Expose fuller workflow-agent explanations instead of short one-line snippets.",
        rationale: improvementMode
          ? "Optimization should also look for computational and resource improvements."
          : "Operators need a readable explanation of what each agent is doing in the current cycle.",
        expectedImpact: improvementMode
          ? "This improves responsiveness and keeps the interface focused."
          : "This makes approvals, planning, and validation easier to review without digging through raw events.",
        priority: "high",
        confidence: 0.92,
        estimatedScope: "small",
        riskLevel: "low",
        relatedPaths: improvementMode
          ? ["src/runtime/appService.ts", "src/shared/workflow.ts"]
          : ["src/renderer/App.tsx", "src/renderer/styles.css"]
      },
      {
        title: improvementMode ? "Harden the workflow against edge cases" : "Trim the workflow layout down to the essentials",
        summary: improvementMode
          ? "Use a bounded pass to tighten bug-prone edges and make the workflow more resilient."
          : "Collapse repeated boxes into a simpler cycle view, recommendation picker, and agent detail panel.",
        rationale: improvementMode
          ? "Optimize mode should include bug recognition and reliability work."
          : "A smaller layout will make the workflow easier to operate from top to bottom.",
        expectedImpact: improvementMode
          ? "This lowers churn and makes future optimization passes safer."
          : "The workflow tab becomes easier to scan and the next action stays obvious.",
        priority: "medium",
        confidence: 0.9,
        estimatedScope: "small",
        riskLevel: "low",
        relatedPaths: improvementMode
          ? ["src/tests/integration.spec.ts", "src/tests/unit.spec.ts"]
          : ["src/renderer/App.tsx", "src/renderer/styles.css"]
      }
    ]
  });
};

const createCustomMockRecommendationPayload = (
  cwd: string,
  customFocus: string,
  objective: MockRecommendationMode = "deliver"
): string =>
  JSON.stringify({
    summary:
      `The repository under ${path.basename(cwd)} is generating recommendations around the custom direction "${customFocus}". The options stay intentionally close to that request while remaining small enough for one cycle.`,
    ultimateGoalProgress: {
      percentComplete: objective !== "deliver" ? 100 : 47,
      rationale: objective !== "deliver"
        ? `The base goal looks satisfied in mock mode, so optimize mode is using "${customFocus}" as the next improvement direction.`
        : `The project already has a clear charter and a focused direction in "${customFocus}", but that direction still needs several bounded cycles before the broader Ultimate Goal is met.`
    },
    ultimateGoalCompletion: {
      state: objective !== "deliver" ? "goal_satisfied" : "needs_more_work",
      rationale: objective !== "deliver"
        ? "The mock transport is treating the main goal as satisfied and the custom focus as an improvement direction."
        : "The mock transport is treating the Ultimate Goal as still in progress."
    },
    recommendations: [
      {
        title: `Implement a bounded slice of ${customFocus}`,
        summary: "Turn the custom direction into one concrete repo change that a single coding pass can finish cleanly.",
        rationale: "The operator already pointed the workflow at this area, so the next recommendation set should stay tightly aligned with that request.",
        expectedImpact: "This lets the next cycle act on the requested direction immediately without spreading into unrelated repo work.",
        priority: "high",
        confidence: 0.96,
        estimatedScope: "small",
        riskLevel: "low",
        relatedPaths: ["src/runtime/appService.ts", "src/renderer/App.tsx"]
      },
      {
        title: `Validate the repo impact of ${customFocus}`,
        summary: "Pair the custom direction with targeted checks or supporting coverage so the change remains reviewable in one cycle.",
        rationale: "A close follow-up recommendation should make the requested direction easier for integrity to verify.",
        expectedImpact: "This reduces churn by keeping the custom idea grounded in concrete validation.",
        priority: "high",
        confidence: 0.91,
        estimatedScope: "small",
        riskLevel: "low",
        relatedPaths: ["src/tests/integration.spec.ts", "src/tests/unit.spec.ts"]
      },
      {
        title: `Tighten the edges around ${customFocus}`,
        summary: "Refine the custom direction into a closely related cleanup or follow-through task that still fits one bounded pass.",
        rationale: "Strongly related alternatives help the user steer the cycle without losing the repo context they already supplied.",
        expectedImpact: "This gives the recommendation picker several near-neighbor options instead of a single narrow path.",
        priority: "medium",
        confidence: 0.88,
        estimatedScope: "small",
        riskLevel: "low",
        relatedPaths: ["src/runtime/workflowRecommendations.ts", "src/shared/workflow.ts"]
      }
    ]
  });

const createMockScopedGoalPayload = (approvedRecommendation?: string): string => {
  const recommendation = approvedRecommendation?.trim() || "the approved recommendation";
  return JSON.stringify({
    summary: `Implement ${recommendation}`,
    executionBrief: [
      `Implement the approved recommendation: ${recommendation}.`,
      "Make the selected recommendation flow into a scoped plan that the coding agent can execute in one pass.",
      "Keep all behavior inside the active project folder and preserve typed IPC and renderer sandboxing.",
      "When the implementation is complete, run the deterministic checks that already exist for this repository and summarize what changed."
    ].join("\n\n"),
    acceptanceCriteria: [
      `The completed work satisfies: ${recommendation}.`,
      "The goal-planning step produces one bounded implementation brief for the coding agent.",
      "The workflow state remains explicit enough for integrity and merge to follow."
    ],
    constraints: [
      "Do not bypass typed IPC.",
      "Do not expose Node APIs in the renderer.",
      "Keep all activity inside the selected project folder."
    ],
    testStrategy: [
      "Run the repository's deterministic validation commands.",
      "Verify the scoped goal still advances the confirmed ultimate goal."
    ]
  });
};

const isUltimateGoalSchema = (value: unknown): boolean => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const properties = (value as { properties?: Record<string, unknown> }).properties;
  return Boolean(properties?.summary && properties?.detailedIntent && properties?.successCriteria && properties?.qualityBar);
};

const isRecommendationSchema = (value: unknown): boolean => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const properties = (value as { properties?: Record<string, unknown> }).properties;
  return Boolean(properties?.summary && properties?.recommendations);
};

const isScopedGoalSchema = (value: unknown): boolean => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const properties = (value as { properties?: Record<string, unknown> }).properties;
  return Boolean(properties?.executionBrief && properties?.acceptanceCriteria && properties?.testStrategy);
};

const extractCustomRecommendationFocus = (input: TurnStartParams["input"]): string | undefined => {
  const combinedText = input
    .filter((entry): entry is Extract<TurnStartParams["input"][number], { type: "text" }> => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
  const match = combinedText.match(/Custom recommendation focus from the operator:\s*(.+)/);
  return match?.[1]?.trim();
};

const extractApprovedRecommendationTitle = (input: TurnStartParams["input"]): string | undefined => {
  const combinedText = input
    .filter((entry): entry is Extract<TurnStartParams["input"][number], { type: "text" }> => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
  const match = combinedText.match(/Approved recommendation:\s*(.+)/);
  return match?.[1]?.trim();
};

const extractWorkflowObjective = (input: TurnStartParams["input"]): MockRecommendationMode => {
  const combinedText = input
    .filter((entry): entry is Extract<TurnStartParams["input"][number], { type: "text" }> => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
  if (/final appeal pass/i.test(combinedText)) {
    return "appeal";
  }
  return /Workflow objective:\s*Optimize/i.test(combinedText) ? "optimize" : "deliver";
};

export class MockCodexTransport extends EventEmitter<TransportEventMap> implements CodexTransport {
  private readonly threads = new Map<string, { id: string; cwd: string; model: string; turns: Array<{ id: string; items: Array<{ id: string; type: string; text?: string }> }> }>();

  private buildMockTurn(id: string, items: ReturnType<MockCodexTransport["buildMockThreadItem"]>[], status: "inProgress" | "completed") {
    return {
      id,
      items,
      status,
      error: null,
      startedAt: Math.floor(Date.now() / 1000),
      completedAt: status === "completed" ? Math.floor(Date.now() / 1000) : null,
      durationMs: status === "completed" ? 0 : null
    };
  }

  private buildMockThreadItem(item: { id: string; type: string; text?: string }) {
    return item.type === "agentMessage"
      ? {
          type: "agentMessage" as const,
          id: item.id,
          text: item.text ?? "",
          phase: null,
          memoryCitation: null
        }
      : {
          type: "userMessage" as const,
          id: item.id,
          content: []
        };
  }

  async initialize(): Promise<InitializeResponse> {
    return {
      userAgent: "mock-codex-agent-workbench",
      codexHome: "/mock/.codex",
      platformFamily: "unix",
      platformOs: "linux"
    };
  }

  async listModels(): Promise<ModelListResponse> {
    return {
      data: [
        {
          id: "gpt-5.5",
          model: "gpt-5.5",
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          displayName: "GPT-5.5",
          description: "Mock newest GPT model",
          hidden: true,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low reasoning" },
            { reasoningEffort: "medium", description: "Medium reasoning" },
            { reasoningEffort: "high", description: "High reasoning" },
            { reasoningEffort: "xhigh", description: "Extra high reasoning" }
          ],
          defaultReasoningEffort: "high",
          inputModalities: ["text"],
          supportsPersonality: true,
          additionalSpeedTiers: [],
          isDefault: false
        },
        {
          id: "gpt-5.4-mini",
          model: "gpt-5.4-mini",
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          displayName: "GPT-5.4 Mini",
          description: "Mock fast model",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low reasoning" },
            { reasoningEffort: "medium", description: "Medium reasoning" },
            { reasoningEffort: "high", description: "High reasoning" }
          ],
          defaultReasoningEffort: "medium",
          inputModalities: ["text"],
          supportsPersonality: true,
          additionalSpeedTiers: [],
          isDefault: true
        },
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          displayName: "GPT-5.4",
          description: "Mock strong model",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low reasoning" },
            { reasoningEffort: "medium", description: "Medium reasoning" },
            { reasoningEffort: "high", description: "High reasoning" },
            { reasoningEffort: "xhigh", description: "Extra high reasoning" }
          ],
          defaultReasoningEffort: "high",
          inputModalities: ["text"],
          supportsPersonality: true,
          additionalSpeedTiers: [],
          isDefault: false
        }
      ],
      nextCursor: null
    };
  }

  async startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    const threadId = nanoid();
    this.threads.set(threadId, {
      id: threadId,
      cwd: params.cwd ?? "/tmp",
      model: params.model ?? "gpt-5.4-mini",
      turns: []
    });
    return {
      thread: {
        id: threadId,
        forkedFromId: null,
        preview: "",
        ephemeral: false,
        modelProvider: "openai",
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        status: { type: "idle" },
        path: null,
        cwd: params.cwd ?? "/tmp",
        cliVersion: "mock",
        source: { custom: "mock" },
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: []
      },
      model: params.model ?? "gpt-5.4-mini",
      modelProvider: "openai",
      serviceTier: null,
      cwd: params.cwd ?? "/tmp",
      instructionSources: [],
      approvalPolicy: params.approvalPolicy ?? "on-request",
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      },
      permissionProfile: null,
      activePermissionProfile: null,
      reasoningEffort: null
    };
  }

  async resumeThread(threadId: string): Promise<ThreadResumeResponse> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Unknown mock thread: ${threadId}`);
    }
    return {
      thread: {
        id: thread.id,
        forkedFromId: null,
        preview: "",
        ephemeral: false,
        modelProvider: "openai",
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        status: { type: "idle" },
        path: null,
        cwd: thread.cwd,
        cliVersion: "mock",
        source: { custom: "mock" },
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: thread.turns.map((turn) => this.buildMockTurn(turn.id, turn.items.map((item) => this.buildMockThreadItem(item)), "completed"))
      },
      model: thread.model,
      modelProvider: "openai",
      serviceTier: null,
      cwd: thread.cwd,
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      },
      permissionProfile: null,
      activePermissionProfile: null,
      reasoningEffort: null
    };
  }

  async readThread(threadId: string, _includeTurns: boolean): Promise<ThreadReadResponse> {
    void _includeTurns;
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Unknown mock thread: ${threadId}`);
    }

    return {
      thread: {
        id: thread.id,
        forkedFromId: null,
        preview: "",
        ephemeral: false,
        modelProvider: "openai",
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        status: { type: "idle" },
        path: null,
        cwd: thread.cwd,
        cliVersion: "mock",
        source: { custom: "mock" },
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: thread.turns.map((turn) => this.buildMockTurn(turn.id, turn.items.map((item) => this.buildMockThreadItem(item)), "completed"))
      }
    };
  }

  async startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
    const turnId = nanoid();
    const itemId = nanoid();
    const thread = this.threads.get(params.threadId);
    const customRecommendationFocus = params.outputSchema && isRecommendationSchema(params.outputSchema)
      ? extractCustomRecommendationFocus(params.input)
      : undefined;
    const workflowObjective = params.outputSchema && isRecommendationSchema(params.outputSchema)
      ? extractWorkflowObjective(params.input)
      : "deliver";
    const responseText = params.outputSchema
      ? isUltimateGoalSchema(params.outputSchema)
        ? createMockUltimateGoalPayload(thread?.cwd ?? "/tmp")
        : isRecommendationSchema(params.outputSchema)
          ? customRecommendationFocus
            ? createCustomMockRecommendationPayload(thread?.cwd ?? "/tmp", customRecommendationFocus, workflowObjective)
            : createMockRecommendationPayload(thread?.cwd ?? "/tmp", workflowObjective)
          : isScopedGoalSchema(params.outputSchema)
            ? createMockScopedGoalPayload(extractApprovedRecommendationTitle(params.input))
            : createMockInterfacePayload(thread?.cwd ?? "/tmp")
      : "Mock agent is processing the task.";
    thread?.turns.push({
      id: turnId,
      items: [
        {
          id: itemId,
          type: "agentMessage",
          text: responseText
        }
      ]
    });
    setTimeout(() => {
      this.emit("notification", {
        method: "turn/started",
        params: {
          threadId: params.threadId,
          turn: this.buildMockTurn(turnId, [], "inProgress")
        }
      } satisfies ServerNotification);
      this.emit("notification", {
        method: "item/agentMessage/delta",
        params: {
          threadId: params.threadId,
          turnId,
          itemId,
          delta: responseText
        }
      } satisfies ServerNotification);
      this.emit("notification", {
        method: "item/completed",
        params: {
          threadId: params.threadId,
          turnId,
          item: {
            type: "agentMessage",
            id: itemId,
            text: responseText,
            phase: null,
            memoryCitation: null
          }
        }
      } satisfies ServerNotification);
      this.emit("notification", {
        method: "turn/completed",
        params: {
          threadId: params.threadId,
          turn: this.buildMockTurn(turnId, [], "completed")
        }
      } satisfies ServerNotification);
    }, MOCK_TURN_COMPLETION_DELAY_MS);

    return {
      turn: {
        id: turnId,
        items: [],
        status: "inProgress",
        error: null,
        startedAt: Math.floor(Date.now() / 1000),
        completedAt: null,
        durationMs: null
      }
    };
  }

  async respond(): Promise<void> {
    return;
  }

  async dispose(): Promise<void> {
    return;
  }
}
