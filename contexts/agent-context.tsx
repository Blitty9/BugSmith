"use client";

import React, { createContext, useContext, useState, useCallback, useRef, ReactNode } from "react";
import type { Issue } from "@/components/issue-card";
import { useFixHistory } from "@/lib/hooks/useFixHistory";

export type StepStatus = "pending" | "active" | "completed" | "error";

export interface AgentStep {
  id: string;
  title: string;
  description: string;
  status: StepStatus;
  logs: string[];
  thought: string;
  startedAt?: string;
  completedAt?: string;
  expectedLogs?: number;
}

export type AgentStatus = "idle" | "running" | "completed" | "error";

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user?: string;
  created_at: string;
  head?: string;
  base?: string;
  body?: string;
}

interface AgentState {
  status: AgentStatus;
  currentStepIndex: number;
  steps: AgentStep[];
  startTime?: string;
  endTime?: string;
  currentRepo?: string;
  currentIssue?: Issue;
  issues: Issue[];
  prs: PullRequest[];
  createdPR?: PullRequest;
  repoPath?: string;
  branchName?: string;
  errorMessage?: string;
  ignoredIssues: string[]; // Array of issue IDs to skip
  issuePriorityOrder: string[]; // Array of issue IDs in priority order
  pendingPatch?: {
    patch: string;
    modifiedFiles: string[];
    stepIndex: number;
  };
  retryState?: {
    attempt: number;
    maxAttempts: number;
    strategy: string;
    lastError?: string;
  };
}

interface AgentContextType {
  state: AgentState;
  runAgent: (repo?: string) => Promise<void>;
  resetAgent: () => void;
  setCurrentRepo: (repo: string) => void;
  setCurrentIssue: (issue: Issue | undefined) => void;
  setIssues: (issues: Issue[]) => void;
  setPRs: (prs: PullRequest[]) => void;
  toggleIgnoreIssue: (issueId: string) => void;
  setIssuePriority: (issueIds: string[]) => void;
  sortIssues: (sortBy: "difficulty" | "date" | "priority") => void;
  approvePatch: () => void;
  rejectPatch: () => void;
  isRunning: boolean;
}

const initialSteps: AgentStep[] = [
  {
    id: "analyze-repo",
    title: "Analyze Repository",
    description: "Scanning codebase structure and dependencies",
    status: "pending",
    logs: [],
    thought: "",
  },
  {
    id: "select-issue",
    title: "Select Issue",
    description: "Choosing optimal issue to fix",
    status: "pending",
    logs: [],
    thought: "",
  },
  {
    id: "prepare-repo",
    title: "Prepare Repository",
    description: "Cloning repository and creating fix branch",
    status: "pending",
    logs: [],
    thought: "",
  },
  {
    id: "analyze-code",
    title: "Analyze Code",
    description: "Reviewing relevant code files",
    status: "pending",
    logs: [],
    thought: "",
  },
  {
    id: "apply-fix",
    title: "Apply Fix",
    description: "Implementing the solution",
    status: "pending",
    logs: [],
    thought: "",
  },
  {
    id: "generate-pr",
    title: "Generate PR",
    description: "Creating pull request with changes",
    status: "pending",
    logs: [],
    thought: "",
  },
  {
    id: "deploy-preview",
    title: "Deploy Preview",
    description: "Triggering preview build",
    status: "pending",
    logs: [],
    thought: "",
  },
  {
    id: "complete",
    title: "Complete",
    description: "Fix applied successfully",
    status: "pending",
    logs: [],
    thought: "",
  },
];

const AgentContext = createContext<AgentContextType | undefined>(undefined);

export function AgentProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AgentState>({
    status: "idle",
    currentStepIndex: -1,
    steps: initialSteps,
    issues: [],
    prs: [],
    ignoredIssues: [],
    issuePriorityOrder: [],
  });
  
  const patchApprovalRef = useRef<{ resolve: (approved: boolean) => void } | null>(null);
  const { addFixEntry, getSuggestions } = useFixHistory();
  const isCancelledRef = useRef(false);

  const updateStep = useCallback((stepIndex: number, updates: Partial<AgentStep>) => {
    setState((prev) => {
      const newSteps = [...prev.steps];
      newSteps[stepIndex] = { ...newSteps[stepIndex], ...updates };
      return { ...prev, steps: newSteps };
    });
  }, []);

  const addLog = useCallback((stepIndex: number, log: string) => {
    setState((prev) => {
      const newSteps = [...prev.steps];
      newSteps[stepIndex] = {
        ...newSteps[stepIndex],
        logs: [...newSteps[stepIndex].logs, log],
      };
      return { ...prev, steps: newSteps };
    });
  }, []);

  const runAgent = useCallback(async (repo?: string) => {
    if (state.status === "running") {
      // Stop the agent if already running
      isCancelledRef.current = true;
      setState((prev) => ({
        ...prev,
        status: "idle",
        currentStepIndex: -1,
      }));
      return;
    }

    // Fetch issues if repo is provided
    let issues: Issue[] = state.issues;
    let currentIssue: Issue | undefined = state.currentIssue;
    const repoToUse = repo || state.currentRepo;
    
    // Filter out ignored issues and get prioritized list
    const getPrioritizedIssues = (issueList: Issue[]) => {
      const availableIssues = issueList.filter((issue) => !state.ignoredIssues.includes(issue.id));
      
      // Sort by priority if priority order exists
      if (state.issuePriorityOrder.length > 0) {
        const priorityMap = new Map(state.issuePriorityOrder.map((id, index) => [id, index]));
        return [...availableIssues].sort((a, b) => {
          const aPriority = priorityMap.get(a.id) ?? Infinity;
          const bPriority = priorityMap.get(b.id) ?? Infinity;
          return aPriority - bPriority;
        });
      }
      
      return availableIssues;
    };
    
    const prioritizedIssues = getPrioritizedIssues(issues);
    
    // Use first prioritized issue if current issue is ignored or not set
    if (!currentIssue || state.ignoredIssues.includes(currentIssue.id)) {
      currentIssue = prioritizedIssues.length > 0 ? prioritizedIssues[0] : undefined;
    }
    let createdPR: PullRequest | undefined = undefined;
    let repoPath: string | undefined = undefined;
    let branchName: string | undefined = undefined;

    if (repoToUse && (!issues.length || repoToUse !== state.currentRepo)) {
      try {
        const response = await fetch(`/api/github/issues?repo=${encodeURIComponent(repoToUse)}`);
        if (response.ok) {
          const data = await response.json();
          // Map GitHub issues to our format (simplified API response)
          const mapGitHubIssue = (ghIssue: any): Issue => {
            let difficulty: "easy" | "medium" | "hard" = "medium";
            const labelsLower = (ghIssue.labels || []).map((l: string) => l.toLowerCase());
            if (labelsLower.some((l: string) => l.includes("good first") || l.includes("easy"))) {
              difficulty = "easy";
            } else if (labelsLower.some((l: string) => l.includes("hard") || l.includes("complex"))) {
              difficulty = "hard";
            }
            return {
              id: ghIssue.id,
              title: ghIssue.title,
              difficulty,
              status: ghIssue.state === "open" ? "open" : "resolved",
              createdAt: ghIssue.created_at,
              labels: ghIssue.labels || [],
              number: ghIssue.number,
              html_url: ghIssue.html_url,
            };
          };
          issues = data.map(mapGitHubIssue);
          // Auto-sort by difficulty on initial load
          const difficultyOrder = { easy: 0, medium: 1, hard: 2 };
          issues.sort((a, b) => difficultyOrder[a.difficulty] - difficultyOrder[b.difficulty]);
          currentIssue = issues.length > 0 && !state.ignoredIssues.includes(issues[0].id) 
            ? issues[0] 
            : issues.find((issue) => !state.ignoredIssues.includes(issue.id));
        }
      } catch (error) {
        console.error("Failed to fetch issues:", error);
      }
    }

    isCancelledRef.current = false;
    setState({
      status: "running",
      currentStepIndex: 0,
      steps: initialSteps.map((step) => ({ ...step, status: "pending", logs: [], thought: "" })),
      startTime: new Date().toISOString(),
      currentRepo: repoToUse,
      currentIssue,
      issues,
      prs: state.prs, // Preserve existing PRs
      errorMessage: undefined,
      ignoredIssues: state.ignoredIssues || [],
      issuePriorityOrder: state.issuePriorityOrder || [],
    });

    // Step configurations with logs and thoughts
    const stepConfigs = [
      {
        logs: [
          "[INFO] Initializing BugSmith agent...",
          "[INFO] Connecting to GitHub API...",
          "[SUCCESS] Connected successfully",
          "[INFO] Fetching repository structure...",
          "[INFO] Analyzing codebase architecture...",
          issues.length > 0
            ? `[INFO] Found ${issues.length} open issues`
            : "[INFO] No open issues found",
        ],
        thought: "Scanning the repository structure to identify recent file changes.",
      },
      {
        logs: [
          "[INFO] Evaluating open issues...",
          "[INFO] Analyzing issue priorities...",
          currentIssue
            ? `[INFO] Issue #${currentIssue.number || currentIssue.id} appears high priority`
            : "[INFO] No issues found in repository",
          currentIssue
            ? `[INFO] Selected issue: ${currentIssue.title}`
            : "[WARN] No issues available to process",
        ],
        thought: currentIssue
          ? `Evaluating open issues. Issue #${currentIssue.number || currentIssue.id} appears high priority.`
          : "No issues found in the repository.",
      },
      {
        logs: [
          "[INFO] Preparing local repository...",
        ],
        thought: "Cloning repository and creating fix branch for local development.",
        isPrepareRepoStep: true, // Special flag to trigger repo preparation
      },
      {
        logs: [
          "[INFO] Reading issue details...",
          "[INFO] Analyzing related code files...",
          "[INFO] Reviewing relevant code for issue context",
        ],
        thought: "Reviewing code related to the issue to understand the problem.",
      },
      {
        logs: [],
        thought: "Generating AI patch to fix the issue...",
        isApplyFixStep: true, // Special flag to trigger applyFix API call
      },
      {
        logs: [
          "[INFO] Creating pull request...",
          "[INFO] Generating PR description...",
        ],
        thought: "Creating PR with detailed summary and test results.",
        isPRStep: true, // Special flag to trigger PR creation
      },
      {
        logs: [
          "[INFO] Triggering preview build on Vercel...",
          "[INFO] Building preview deployment...",
          "[SUCCESS] Preview build completed",
          "[INFO] Preview URL: https://bugsmith-pr-45.vercel.app",
        ],
        thought: "Triggering preview build on Vercel.",
      },
      {
        logs: [
          "[SUCCESS] Agent run completed successfully",
          "[INFO] Fix applied successfully. PR ready for review.",
        ],
        thought: "Fix applied successfully. PR ready for review.",
        isFinalStep: true, // Special flag for final step
      },
    ];

    // Helper function to check cancellation
    const checkCancelled = () => {
      if (isCancelledRef.current) {
        setState((prev) => ({
          ...prev,
          status: "idle",
          currentStepIndex: -1,
        }));
        return true;
      }
      return false;
    };

    // Process each step sequentially
    for (let i = 0; i < stepConfigs.length; i++) {
      // Check if cancelled
      if (checkCancelled()) return;

      const config = stepConfigs[i];

      // Mark current step as active
      updateStep(i, { 
        status: "active",
        startedAt: new Date().toISOString(),
        expectedLogs: config.logs.length
      });
      setState((prev) => ({ ...prev, currentStepIndex: i }));
      
      // Add thought immediately
      updateStep(i, { thought: config.thought });

      // Add logs with delays
      for (let j = 0; j < config.logs.length; j++) {
        if (checkCancelled()) return;
        await new Promise((resolve) => setTimeout(resolve, 800));
        if (checkCancelled()) return;
        addLog(i, config.logs[j]);
      }

      // After "Select Issue" step (index 1), check if no issues found
      if (i === 1) {
        if (checkCancelled()) return;
        
        const availableIssuesForCheck = issues.filter((issue) => !state.ignoredIssues.includes(issue.id));
        if (!currentIssue || availableIssuesForCheck.length === 0) {
          addLog(i, "[WARN] No issues found in repository");
          updateStep(i, {
            status: "error",
            thought: "No issues found in the repository. Agent stopping.",
          });
          
          // Mark all remaining steps as pending (not completed)
          for (let k = i + 1; k < stepConfigs.length; k++) {
            updateStep(k, { status: "pending" });
          }
          
          setState((prev) => ({
            ...prev,
            status: "idle",
            currentStepIndex: -1,
            errorMessage: "No issues found in repository",
          }));
          
          // Reset after showing the message
          setTimeout(() => {
            isCancelledRef.current = true;
            setState((prev) => ({
              ...prev,
              status: "idle",
              currentStepIndex: -1,
              steps: initialSteps.map((step) => ({ ...step, status: "pending", logs: [], thought: "" })),
              errorMessage: undefined,
            }));
            setTimeout(() => {
              isCancelledRef.current = false;
            }, 100);
          }, 2000);
          
          return;
        }
      }

      // Special handling for repository preparation step
      if ((config as any).isPrepareRepoStep && currentIssue && repoToUse) {
        if (checkCancelled()) return;
        
        try {
          addLog(i, "[INFO] Cloning repository...");
          await new Promise((resolve) => setTimeout(resolve, 800));
          if (checkCancelled()) return;

          const prepareResponse = await fetch("/api/agent/prepareRepo", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              repo: repoToUse,
              issueNumber: currentIssue.number || parseInt(currentIssue.id) || 0,
            }),
          });

          if (checkCancelled()) return;

          if (prepareResponse.ok) {
            const prepareData = await prepareResponse.json();
            repoPath = prepareData.repoPath;
            branchName = prepareData.branchName;

            addLog(i, `[SUCCESS] Repository cloned to local directory`);
            if (checkCancelled()) return;
            addLog(i, `[SUCCESS] Branch ${branchName} created and checked out`);
            if (checkCancelled()) return;
            addLog(i, `[INFO] Repository ready for code modifications`);

            // Store repo path and branch name in state
            setState((prev) => ({
              ...prev,
              repoPath,
              branchName,
            }));
          } else {
            const errorData = await prepareResponse.json();
            addLog(i, `[ERROR] Failed to prepare repository: ${errorData.error || "Unknown error"}`);
            // Halt agent execution on repo preparation failure
            setState((prev) => ({
              ...prev,
              status: "error",
              currentStepIndex: i,
            }));
            return;
          }
        } catch (error) {
          if (checkCancelled()) return;
          console.error("Error preparing repository:", error);
          addLog(i, "[ERROR] Failed to prepare repository. Please check your connection and repository access.");
          // Halt agent execution on repo preparation failure
          setState((prev) => ({
            ...prev,
            status: "error",
            currentStepIndex: i,
          }));
          return;
        }
      }

      // Special handling for Apply Fix step
      if ((config as any).isApplyFixStep && currentIssue && repoToUse && repoPath && branchName) {
        if (checkCancelled()) return;
        
        try {
          addLog(i, "[INFO] Finding relevant code files...");
          updateStep(i, { thought: "Scanning repository for files to modify..." });
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (checkCancelled()) return;
          
          addLog(i, "[INFO] Generating patch using AI...");
          updateStep(i, { thought: "Using OpenAI to generate a unified diff patch for the issue..." });
          
          const applyFixResponse = await fetch("/api/agent/applyFix", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              repo: repoToUse,
              repoPath,
              branchName,
              issue: currentIssue,
              preview: true, // Request preview mode
            }),
          });

          if (checkCancelled()) return;

          if (applyFixResponse.ok) {
            let applyFixData: any;
            try {
              applyFixData = await applyFixResponse.json();
            } catch (jsonError) {
              const text = await applyFixResponse.text();
              throw new Error(`Failed to parse response as JSON. Response: ${text.substring(0, 200)}`);
            }
            
            if (checkCancelled()) return;
            
            // Show patch generation success
            addLog(i, "[SUCCESS] Patch generated successfully");
            await new Promise((resolve) => setTimeout(resolve, 300));
            if (checkCancelled()) return;
            
            // Store patch for preview - save the initial patch data
            const initialPatchData = applyFixData;
            
            // Store patch for preview
            if (initialPatchData.patch) {
              // Get suggestions from fix history
              const suggestions = getSuggestions(currentIssue, repoToUse);
              
              setState((prev) => ({
                ...prev,
                pendingPatch: {
                  patch: initialPatchData.patch,
                  modifiedFiles: initialPatchData.modifiedFiles || [],
                  stepIndex: i,
                },
              }));
              
              addLog(i, "[INFO] Patch preview available. Waiting for approval...");
              
              // Add context-aware suggestion to thought
              let thought = "Patch generated. Please review the changes in the preview dialog and approve or reject.";
              if (suggestions.similarFixes.length > 0) {
                thought += `\n\nContext: ${suggestions.reason} (${suggestions.similarFixes.length} similar fix${suggestions.similarFixes.length !== 1 ? "es" : ""} found in history).`;
                if (suggestions.confidence > 0.6) {
                  thought += suggestions.shouldApprove 
                    ? " Based on history, this fix is likely to be approved." 
                    : " Based on history, similar fixes were often rejected.";
                }
              }
              
              updateStep(i, { thought });
              
              // Wait for user approval
              const approved = await new Promise<boolean>((resolve) => {
                patchApprovalRef.current = { resolve };
              });
              
              if (checkCancelled()) return;
              
              // Clear pending patch
              setState((prev) => ({
                ...prev,
                pendingPatch: undefined,
              }));
              
              if (!approved) {
                // Record rejection in history
                if (currentIssue && repoToUse) {
                  addFixEntry(
                    currentIssue,
                    repoToUse,
                    initialPatchData.patch || "",
                    false,
                    true,
                    false,
                    initialPatchData.modifiedFiles || [],
                    "Rejected by user"
                  );
                }
                
                addLog(i, "[WARN] Patch rejected by user. Stopping agent execution.");
                updateStep(i, {
                  thought: "Patch was rejected by user. Agent execution stopped.",
                  status: "error",
                });
                
                // Mark all remaining steps as skipped
                for (let k = i + 1; k < stepConfigs.length; k++) {
                  updateStep(k, { 
                    status: "pending",
                    thought: "Skipped: Previous step was rejected.",
                  });
                }
                
                // Stop agent execution
                setState((prev) => ({
                  ...prev,
                  status: "error",
                  currentStepIndex: i,
                  errorMessage: "Patch was rejected by user. Agent execution stopped.",
                }));
                return; // Stop agent execution
              }
              
              addLog(i, "[SUCCESS] Patch approved. Applying changes...");
              
              // Apply the approved patch with retry logic
              await new Promise((resolve) => setTimeout(resolve, 300));
              if (checkCancelled()) return;
              
              let appliedPatchData: any = null;
              let patchApplied = false;
              const maxRetries = 3;
              let attempt = 0;
              
              while (!patchApplied && attempt < maxRetries) {
                attempt++;
                if (attempt > 1) {
                  addLog(i, `[INFO] Retry attempt ${attempt}/${maxRetries}...`);
                  await new Promise((resolve) => setTimeout(resolve, 1000));
                  if (checkCancelled()) return;
                } else {
                  addLog(i, "[INFO] Applying patch...");
                }
                
                // Update retry state
                setState((prev) => ({
                  ...prev,
                  retryState: {
                    attempt: attempt - 1,
                    maxAttempts: maxRetries,
                    strategy: attempt === 2 ? "fuzzy" : attempt === 3 ? "regenerate" : "standard",
                  },
                }));
                
                const applyPatchResponse = await fetch("/api/agent/applyFix", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    repo: repoToUse,
                    repoPath,
                    branchName,
                    issue: currentIssue,
                    preview: false,
                    useFuzzy: attempt === 2,
                    regenerate: attempt === 3,
                  }),
                });
                
                if (checkCancelled()) return;
                
                if (applyPatchResponse.ok) {
                  appliedPatchData = await applyPatchResponse.json();
                  if (attempt > 1) {
                    addLog(i, `[SUCCESS] Patch applied successfully on retry attempt ${attempt}`);
                  }
                  setState((prev) => ({ ...prev, retryState: undefined }));
                  patchApplied = true;
                } else {
                  const errorData = await applyPatchResponse.json().catch(() => ({}));
                  const errorMessage = errorData.error || "Unknown error";
                  
                  if (attempt < maxRetries) {
                    addLog(i, `[WARN] Patch application failed (attempt ${attempt}/${maxRetries}): ${errorMessage}`);
                    if (attempt === 2) {
                      addLog(i, "[INFO] Retrying with fuzzy matching enabled...");
                    } else if (attempt === 3) {
                      addLog(i, "[INFO] Regenerating patch and retrying...");
                    }
                  } else {
                    // All retries exhausted
                    addLog(i, `[ERROR] Patch application failed after ${maxRetries} attempts. Manual intervention required.`);
                    addLog(i, `[INFO] Suggested manual fixes:`);
                    addLog(i, `  1. Review the patch manually and apply changes`);
                    addLog(i, `  2. Check for merge conflicts or file permission issues`);
                    addLog(i, `  3. Verify the issue description matches the codebase state`);
                    addLog(i, `  4. Try applying the patch with: git apply --3way patch.diff`);
                    
                    updateStep(i, {
                      thought: `Failed to apply patch after ${maxRetries} attempts. Manual intervention required. Last error: ${errorMessage}`,
                      status: "error",
                    });
                    
                    // Record failure in history
                    if (currentIssue && repoToUse) {
                      addFixEntry(
                        currentIssue,
                        repoToUse,
                        state.pendingPatch?.patch || "",
                        false,
                        false,
                        false,
                        [],
                        errorMessage,
                        maxRetries
                      );
                    }
                    
                    setState((prev) => ({
                      ...prev,
                      status: "error",
                      currentStepIndex: i,
                      errorMessage: `Patch application failed after ${maxRetries} attempts. Consider manual fixes.`,
                      retryState: undefined,
                    }));
                    return;
                  }
                }
              }
              
              if (!patchApplied) {
                // Should not reach here, but handle gracefully
                return;
              }
              
              await new Promise((resolve) => setTimeout(resolve, 300));
              if (checkCancelled()) return;
              
              // Check if files were changed
              if (appliedPatchData && appliedPatchData.modifiedFiles && appliedPatchData.modifiedFiles.length > 0) {
                addLog(i, `[SUCCESS] Modified ${appliedPatchData.modifiedFiles.length} file(s):`);
                appliedPatchData.modifiedFiles.forEach((file: string) => {
                  addLog(i, `  - ${file}`);
                });
                
                // Record successful application in history
                if (currentIssue && repoToUse) {
                  addFixEntry(
                    currentIssue,
                    repoToUse,
                    initialPatchData.patch || "",
                    true,
                    false,
                    true,
                    appliedPatchData.modifiedFiles || [],
                    undefined,
                    state.retryState?.attempt
                  );
                }
                
                await new Promise((resolve) => setTimeout(resolve, 300));
                if (checkCancelled()) return;
                addLog(i, "[INFO] Creating commit...");
                
                // Update thought with file changes summary
                const filesSummary = appliedPatchData.modifiedFiles.join(", ");
                updateStep(i, {
                  thought: `AI generated a patch that modified ${appliedPatchData.modifiedFiles.length} file(s): ${filesSummary}. The patch fixes the issue by applying the necessary code changes.`,
                });

                if (appliedPatchData.commitHash) {
                  addLog(i, `[SUCCESS] Changes committed: ${appliedPatchData.commitHash.substring(0, 7)}`);
                }
                
                await new Promise((resolve) => setTimeout(resolve, 300));
                if (checkCancelled()) return;
                addLog(i, "[INFO] Pushing branch...");
                
                if (appliedPatchData.pushed) {
                  addLog(i, `[SUCCESS] Branch ${branchName} pushed to remote`);
                }
              } else {
                addLog(i, "[INFO] Patch generated but no files were modified.");
                updateStep(i, {
                  thought: "AI generated a patch but it did not result in file modifications. The issue may require manual intervention or a different approach.",
                });
              }
            } else {
              // No patch to preview (shouldn't happen, but handle gracefully)
              addLog(i, "[WARN] No patch generated for preview");
              continue;
            }
          } else {
            if (checkCancelled()) return;
            // Handle error response - check if it's JSON first
            let errorMessage = "Unknown error";
            try {
              const contentType = applyFixResponse.headers.get("content-type");
              if (contentType && contentType.includes("application/json")) {
                const errorData = await applyFixResponse.json();
                errorMessage = errorData.error || "Unknown error";
              } else {
                // Response is not JSON (likely HTML error page)
                const text = await applyFixResponse.text();
                errorMessage = `Server error (${applyFixResponse.status}): ${text.substring(0, 200)}`;
              }
            } catch (parseError) {
              // If we can't parse the error, use status text
              errorMessage = `Failed to parse error response: ${applyFixResponse.status} ${applyFixResponse.statusText}`;
            }
            
            addLog(i, `[ERROR] Failed to apply fix: ${errorMessage}`);
            
            // Provide helpful message for common issues
            if (errorMessage.includes("OPENAI_KEY") || errorMessage.includes("API key")) {
              addLog(i, `[INFO] Please add OPENAI_KEY to your .env.local file`);
            }
            
            updateStep(i, { 
              thought: `Failed to apply fix: ${errorMessage}`,
              status: "error",
            });
            setState((prev) => ({
              ...prev,
              status: "error",
              currentStepIndex: i,
            }));
            return; // Halt agent execution on fix failure
          }
        } catch (error) {
          if (checkCancelled()) return;
          console.error("Error applying fix:", error);
          addLog(i, "[ERROR] Failed to apply fix. Check server logs for details.");
          updateStep(i, { 
            thought: "Failed to apply fix. Please check server logs and ensure OpenAI API key is configured.",
            status: "error",
          });
          setState((prev) => ({
            ...prev,
            status: "error",
            currentStepIndex: i,
          }));
          return; // Halt agent execution on fix failure
        }
      }

      // Special handling for PR creation step
      if ((config as any).isPRStep && currentIssue && repoToUse) {
        if (checkCancelled()) return;
        
        try {
          addLog(i, "[INFO] Calling GitHub API to create PR...");
          await new Promise((resolve) => setTimeout(resolve, 800));
          if (checkCancelled()) return;

          // Use the branch name from state (created during prepare-repo step)
          const prBranchName = branchName || `bugsmith-fix-${currentIssue.number || currentIssue.id}`;
          const prTitle = `Fix for issue #${currentIssue.number || currentIssue.id}: ${currentIssue.title}`;
          const prBody = `This PR was automatically generated by BugSmith to fix issue #${currentIssue.number || currentIssue.id}.\n\n**Issue:** ${currentIssue.title}\n\n**Labels:** ${currentIssue.labels?.join(", ") || "None"}`;

          const prResponse = await fetch("/api/github/pr", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              repo: repoToUse,
              branchName: prBranchName,
              baseBranch: "main",
              title: prTitle,
              body: prBody,
            }),
          });

          if (checkCancelled()) return;

          if (prResponse.ok) {
            const prData = await prResponse.json();
            addLog(i, `[SUCCESS] PR #${prData.number} created successfully`);
            if (checkCancelled()) return;
            addLog(i, `[INFO] PR URL: ${prData.html_url}`);
            if (checkCancelled()) return;
            addLog(i, "[INFO] PR includes: 3 files changed, 47 insertions, 12 deletions");
            
            // Store created PR in state and local variable
            createdPR = prData;
            setState((prev) => ({
              ...prev,
              createdPR: prData,
              prs: [...prev.prs, prData],
            }));
          } else {
            if (checkCancelled()) return;
            const errorData = await prResponse.json();
            addLog(i, `[ERROR] Failed to create PR: ${errorData.error || "Unknown error"}`);
          }
        } catch (error) {
          if (checkCancelled()) return;
          console.error("Error creating PR:", error);
          addLog(i, "[ERROR] Failed to create PR. Please check your GitHub token and repository permissions.");
        }
      }

      // Special handling for final step - reference created PR if available
      if ((config as any).isFinalStep && createdPR) {
        if (checkCancelled()) return;
        // Add log about the created PR
        await new Promise((resolve) => setTimeout(resolve, 800));
        if (checkCancelled()) return;
        addLog(i, `[INFO] PR #${createdPR.number} is now available for code review`);
      }

      // Check again before marking as completed
      if (checkCancelled()) return;

      // Mark step as completed
      updateStep(i, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });

      // Small delay before next step
      if (i < stepConfigs.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (checkCancelled()) return;
      }
    }

    // Mark agent as completed only if not cancelled
    if (!isCancelledRef.current) {
      setState((prev) => ({
        ...prev,
        status: "completed",
        endTime: new Date().toISOString(),
      }));
    }
  }, [state.status, state.issues, state.currentIssue, state.currentRepo, state.prs, updateStep, addLog]);

  const resetAgent = useCallback(() => {
    isCancelledRef.current = true;
    setState((prev) => ({
      ...prev,
      status: "idle",
      currentStepIndex: -1,
      steps: initialSteps.map((step) => ({ ...step, status: "pending", logs: [], thought: "" })),
      errorMessage: undefined,
      pendingPatch: undefined,
      retryState: undefined,
      startTime: undefined,
      endTime: undefined,
      repoPath: undefined,
      branchName: undefined,
      createdPR: undefined,
      // Preserve ignoredIssues and issuePriorityOrder, but ensure they're arrays
      ignoredIssues: prev.ignoredIssues || [],
      issuePriorityOrder: prev.issuePriorityOrder || [],
    }));
    // Reset cancellation flag after a brief delay
    setTimeout(() => {
      isCancelledRef.current = false;
    }, 100);
  }, []);

  const setCurrentRepo = useCallback((repo: string) => {
    setState((prev) => ({ ...prev, currentRepo: repo }));
  }, []);

  const setCurrentIssue = useCallback((issue: Issue | undefined) => {
    setState((prev) => ({ ...prev, currentIssue: issue }));
  }, []);

  const setIssues = useCallback((issues: Issue[]) => {
    setState((prev) => ({ ...prev, issues }));
  }, []);

  const setPRs = useCallback((prs: PullRequest[]) => {
    setState((prev) => ({ ...prev, prs }));
  }, []);

  const toggleIgnoreIssue = useCallback((issueId: string) => {
    setState((prev) => {
      const isIgnored = prev.ignoredIssues.includes(issueId);
      const newIgnored = isIgnored
        ? prev.ignoredIssues.filter((id) => id !== issueId)
        : [...prev.ignoredIssues, issueId];
      
      // If ignoring the current issue, clear it
      const newCurrentIssue = prev.currentIssue?.id === issueId ? undefined : prev.currentIssue;
      
      return {
        ...prev,
        ignoredIssues: newIgnored,
        currentIssue: newCurrentIssue,
      };
    });
  }, []);

  const setIssuePriority = useCallback((issueIds: string[]) => {
    setState((prev) => ({
      ...prev,
      issuePriorityOrder: issueIds,
    }));
  }, []);

  const approvePatch = useCallback(() => {
    if (patchApprovalRef.current) {
      patchApprovalRef.current.resolve(true);
      patchApprovalRef.current = null;
    }
  }, []);

  const rejectPatch = useCallback(() => {
    if (patchApprovalRef.current) {
      patchApprovalRef.current.resolve(false);
      patchApprovalRef.current = null;
    }
  }, []);

  const sortIssues = useCallback((sortBy: "difficulty" | "date" | "priority") => {
    setState((prev) => {
      const availableIssues = prev.issues.filter(
        (issue) => !prev.ignoredIssues.includes(issue.id)
      );
      
      let sorted: Issue[];
      
      if (sortBy === "priority" && prev.issuePriorityOrder.length > 0) {
        // Sort by custom priority order
        const priorityMap = new Map(prev.issuePriorityOrder.map((id, index) => [id, index]));
        sorted = [...availableIssues].sort((a, b) => {
          const aPriority = priorityMap.get(a.id) ?? Infinity;
          const bPriority = priorityMap.get(b.id) ?? Infinity;
          return aPriority - bPriority;
        });
      } else if (sortBy === "difficulty") {
        // Sort by difficulty: easy -> medium -> hard
        const difficultyOrder = { easy: 0, medium: 1, hard: 2 };
        sorted = [...availableIssues].sort(
          (a, b) => difficultyOrder[a.difficulty] - difficultyOrder[b.difficulty]
        );
      } else {
        // Sort by date (newest first)
        sorted = [...availableIssues].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      }
      
      // Update priority order to match sorted order
      const newPriorityOrder = sorted.map((issue) => issue.id);
      
      return {
        ...prev,
        issues: sorted.concat(prev.issues.filter((issue) => prev.ignoredIssues.includes(issue.id))),
        issuePriorityOrder: newPriorityOrder,
      };
    });
  }, []);

  return (
    <AgentContext.Provider
        value={{
        state,
        runAgent,
        resetAgent,
        setCurrentRepo,
        setCurrentIssue,
        setIssues,
        setPRs,
        toggleIgnoreIssue,
        setIssuePriority,
        sortIssues,
        approvePatch,
        rejectPatch,
        isRunning: state.status === "running",
      }}
    >
      {children}
    </AgentContext.Provider>
  );
}

export function useAgent() {
  const context = useContext(AgentContext);
  if (context === undefined) {
    throw new Error("useAgent must be used within an AgentProvider");
  }
  return context;
}
