"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/status-chip";
import { Play, FileText, GitPullRequest, Activity, Square } from "lucide-react";
import { IssueCard, type Issue } from "@/components/issue-card";
import { formatDateTime } from "@/lib/utils";
import { useAgent } from "@/contexts/agent-context";
import Link from "next/link";

export default function DashboardPage() {
  const { state, runAgent, isRunning, resetAgent } = useAgent();
  const [activityLog, setActivityLog] = useState<Array<{
    id: string;
    timestamp: string;
    action: string;
    type: "success" | "error" | "info";
  }>>([]);

  // Add activity log entry when agent completes
  useEffect(() => {
    if (state.status === "completed" && state.endTime) {
      const newEntry = {
        id: Date.now().toString(),
        timestamp: state.endTime,
        action: "Agent run completed successfully",
        type: "success" as const,
      };
      setActivityLog((prev) => [newEntry, ...prev]);
    }
  }, [state.status, state.endTime]);

  // Add activity log entry when PR is created
  useEffect(() => {
    if (state.createdPR) {
      const newEntry = {
        id: `pr-${state.createdPR.number}-${Date.now()}`,
        timestamp: state.createdPR.created_at,
        action: `PR #${state.createdPR.number} created successfully`,
        type: "success" as const,
      };
      setActivityLog((prev) => {
        // Check if this PR entry already exists
        const exists = prev.some((entry) => entry.id.startsWith(`pr-${state.createdPR!.number}`));
        if (exists) return prev;
        return [newEntry, ...prev];
      });
    }
  }, [state.createdPR]);

  const handleRunAgent = async () => {
    if (isRunning) {
      resetAgent();
    } else {
      await runAgent();
    }
  };

  const currentStep = state.currentStepIndex >= 0 
    ? state.steps[state.currentStepIndex] 
    : null;

  return (
    <div className="p-6 space-y-6">
      {/* Header with fade-in */}
      <div className="flex items-center justify-between fade-in-up">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Dashboard</h1>
          <p className="text-foreground-muted mt-1">
            Developer Mission Control - Monitor your AI agent activity
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleRunAgent} className="hover-scale">
            {isRunning ? (
              <>
                <Square className="mr-2 h-4 w-4" />
                Stop Agent
              </>
            ) : (
              <>
                <Play className="mr-2 h-4 w-4" />
                Run Agent
              </>
            )}
          </Button>
          <Link href="/agent-run">
            <Button variant="outline" className="hover-scale">
              <FileText className="mr-2 h-4 w-4" />
              View Logs
            </Button>
          </Link>
        </div>
      </div>

      {/* Cards Grid with staggered animations */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* Agent Status Card */}
        <Card className="card-animated hover-lift" style={{ animationDelay: "0.1s" }}>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              Agent Status
              <StatusChip 
                status={
                  state.status === "running" 
                    ? "running" 
                    : state.status === "completed"
                    ? "completed"
                    : "idle"
                } 
              />
            </CardTitle>
            <CardDescription>
              Current state of the autonomous agent
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-foreground-muted">Current Step:</span>
                <span className="text-foreground">
                  {currentStep ? currentStep.title : "Idle"}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-foreground-muted">Tasks Completed:</span>
                <span className="text-foreground">
                  {state.steps.filter((s) => s.status === "completed").length} / {state.steps.length}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-foreground-muted">Status:</span>
                <span className="text-foreground capitalize">{state.status}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Active Task Card */}
        <Card className="card-animated hover-lift" style={{ animationDelay: "0.2s" }}>
          <CardHeader>
            <CardTitle>Active Task</CardTitle>
            <CardDescription>
              {state.currentIssue 
                ? `Processing issue #${state.currentIssue.number || state.currentIssue.id}`
                : currentStep 
                ? "Currently processing" 
                : "No active task"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {state.currentIssue ? (
              <IssueCard issue={state.currentIssue} />
            ) : currentStep ? (
              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">{currentStep.title}</div>
                <div className="text-xs text-foreground-muted">{currentStep.description}</div>
                {currentStep.thought && (
                  <div className="mt-2 rounded-md border border-border bg-background p-2 fade-in">
                    <div className="text-xs text-foreground-muted italic">{currentStep.thought}</div>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-md border border-border bg-background p-4 text-center">
                <p className="text-sm text-foreground-muted">
                  {state.issues.length > 0
                    ? "No issue selected. Select an issue from the Issues page."
                    : "No data yet. Fetch issues from the Issues page to get started."}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quick Stats Card */}
        <Card className="card-animated hover-lift" style={{ animationDelay: "0.3s" }}>
          <CardHeader>
            <CardTitle>Quick Stats</CardTitle>
            <CardDescription>Overview of agent performance</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-foreground-muted" />
                  <span className="text-sm text-foreground-muted">Open Issues</span>
                </div>
                <span className="text-lg font-semibold text-foreground">
                  {state.issues.length > 0 ? (
                    state.issues.length
                  ) : (
                    <span className="text-sm text-foreground-muted font-normal">
                      Connect a repo on the Issues page
                    </span>
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <GitPullRequest className="h-4 w-4 text-foreground-muted" />
                  <span className="text-sm text-foreground-muted">Open PRs</span>
                </div>
                <span className="text-lg font-semibold text-foreground">
                  {state.prs.length > 0 ? state.prs.length : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-foreground-muted" />
                  <span className="text-sm text-foreground-muted">This Week</span>
                </div>
                <span className="text-lg font-semibold text-foreground">
                  {state.issues.length > 0 ? state.issues.length : "—"}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity Log with fade-in */}
      <Card className="fade-in-up hover-lift" style={{ animationDelay: "0.4s", opacity: 0 }}>
        <CardHeader>
          <CardTitle>Recent Activity Log</CardTitle>
          <CardDescription>
            Latest actions performed by the agent
          </CardDescription>
        </CardHeader>
        <CardContent>
          {activityLog.length > 0 ? (
            <div className="space-y-3">
              {activityLog.map((activity, index) => (
                <div
                  key={activity.id}
                  className="flex items-start gap-3 rounded-md border border-border bg-background p-3 list-item hover-scale transition-all duration-200"
                  style={{ animationDelay: `${0.5 + index * 0.1}s` }}
                >
                  <div
                    className={`mt-0.5 h-2 w-2 rounded-full transition-all duration-300 ${
                      activity.type === "success"
                        ? "bg-success"
                        : activity.type === "error"
                        ? "bg-destructive"
                        : "bg-primary"
                    }`}
                  />
                  <div className="flex-1">
                    <div className="text-sm text-foreground">{activity.action}</div>
                    <div className="mt-1 text-xs text-foreground-muted">
                      {formatDateTime(activity.timestamp)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-border bg-background p-8 text-center">
              <Activity className="h-8 w-8 text-foreground-muted mx-auto mb-3" />
              <p className="text-sm text-foreground-muted">
                No activity yet. Agent activity will appear here once you run the agent.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
