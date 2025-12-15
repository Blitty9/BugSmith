"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/status-chip";
import { PRCard, type PullRequest as PRCardPullRequest } from "@/components/pr-card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GitMerge, GitPullRequest, GitBranch, Github, Loader2, AlertCircle, RefreshCw, CheckCircle2 } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useAgent } from "@/contexts/agent-context";
import type { PullRequest } from "@/contexts/agent-context";

interface GitHubPR {
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

/**
 * Maps GitHub API PR response to PRCard format
 */
function mapGitHubPRToPRCard(githubPR: GitHubPR | PullRequest): PRCardPullRequest {
  // Handle both GitHub API format and our internal format
  const isGitHubFormat = "number" in githubPR && typeof githubPR.number === "number";
  
  return {
    id: isGitHubFormat ? githubPR.number.toString() : (githubPR as any).id || githubPR.number.toString(),
    title: githubPR.title,
    branch: githubPR.head || (githubPR as any).branch || "unknown",
    baseBranch: githubPR.base || (githubPR as any).baseBranch || "main",
    status: (githubPR.state === "open" ? "open" : githubPR.state === "closed" ? "closed" : "merged") as "open" | "merged" | "closed",
    summary: githubPR.body || (githubPR as any).summary || "No description provided.",
    createdAt: githubPR.created_at,
    author: githubPR.user || (githubPR as any).author || "Unknown",
  };
}

export default function PRsPage() {
  const { state, setPRs } = useAgent();
  const [selectedPR, setSelectedPR] = useState<PRCardPullRequest | null>(null);
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeSuccess, setMergeSuccess] = useState(false);

  // Fetch PRs when component mounts or repo changes
  const fetchPRs = useCallback(async () => {
    if (!state.currentRepo) {
      setError("No repository selected. Please fetch issues from the Issues page first.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/github/prs?repo=${encodeURIComponent(state.currentRepo)}`);
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Failed to fetch pull requests");
        return;
      }

      const formattedPRs = data.map(mapGitHubPRToPRCard);
      setPRs(data); // Store in context as GitHub format
    } catch (err) {
      setError("Failed to fetch pull requests. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [state.currentRepo, setPRs]);

  // Auto-fetch PRs when repo is available
  useEffect(() => {
    if (state.currentRepo && state.prs.length === 0) {
      fetchPRs();
    }
  }, [state.currentRepo, state.prs.length, fetchPRs]);

  // Handle PR merge
  const handleMergePR = async () => {
    if (!selectedPR || !state.currentRepo) {
      setMergeError("No PR selected or repository not available");
      return;
    }

    // Don't allow merging if already merged
    if (selectedPR.status === "merged") {
      setMergeError("This pull request is already merged");
      return;
    }

    setMerging(true);
    setMergeError(null);
    setMergeSuccess(false);

    try {
      const response = await fetch("/api/github/pr/merge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repo: state.currentRepo,
          pullNumber: parseInt(selectedPR.id),
          mergeMethod: "merge",
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setMergeError(data.error || "Failed to merge pull request");
        return;
      }

      setMergeSuccess(true);
      
      // Update the PR status in the UI
      setSelectedPR({
        ...selectedPR,
        status: "merged",
      });

      // Refresh PRs list after a short delay
      setTimeout(() => {
        fetchPRs();
      }, 1000);
    } catch (err) {
      setMergeError("Failed to merge pull request. Please try again.");
    } finally {
      setMerging(false);
    }
  };

  // Convert context PRs to PRCard format for display
  const displayPRs = state.prs.map(mapGitHubPRToPRCard);

  return (
    <div className="p-6 space-y-6">
      {/* Header with fade-in */}
      <div className="flex items-center justify-between fade-in-up">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Pull Requests</h1>
          <p className="text-foreground-muted mt-1">
            Pull requests for {state.currentRepo || "selected repository"}
          </p>
        </div>
        <div className="flex gap-2">
          {state.currentRepo && (
            <Button onClick={fetchPRs} disabled={loading} variant="outline" className="hover-scale">
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading...
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Refresh
                </>
              )}
            </Button>
          )}
          <button
            onClick={() => setViewMode("table")}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 hover-scale ${
              viewMode === "table"
                ? "bg-muted text-foreground"
                : "text-foreground-muted hover:text-foreground"
            }`}
          >
            Table
          </button>
          <button
            onClick={() => setViewMode("cards")}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 hover-scale ${
              viewMode === "cards"
                ? "bg-muted text-foreground"
                : "text-foreground-muted hover:text-foreground"
            }`}
          >
            Cards
          </button>
        </div>
      </div>

      {!state.currentRepo && (
        <Alert className="fade-in-up">
          <Github className="h-4 w-4" />
          <AlertTitle>No Repository Selected</AlertTitle>
          <AlertDescription>
            Please fetch issues from the Issues page to select a repository first.
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive" className="fade-in-up">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!loading && displayPRs.length === 0 && state.currentRepo && !error && (
        <div className="rounded-md border border-border bg-background p-8 text-center fade-in-up">
          <GitPullRequest className="h-12 w-12 text-foreground-muted mx-auto mb-4" />
          <p className="text-foreground-muted">
            No open pull requests found for this repository.
          </p>
        </div>
      )}

      {viewMode === "table" && displayPRs.length > 0 ? (
        <Card className="fade-in-up hover-lift">
          <CardHeader>
            <CardTitle>Pull Requests</CardTitle>
            <CardDescription>
              All pull requests for {state.currentRepo}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Author</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayPRs.map((pr, index) => (
                  <TableRow
                    key={pr.id}
                    className="cursor-pointer hover:bg-muted/50 transition-colors table-row hover-scale"
                    onClick={() => setSelectedPR(pr)}
                    style={{ animationDelay: `${index * 0.05}s` }}
                  >
                    <TableCell className="font-medium">#{pr.id}</TableCell>
                    <TableCell>{pr.title}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <GitBranch className="h-3 w-3 text-foreground-muted" />
                        <span className="text-sm">{pr.branch}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusChip
                        status={
                          pr.status === "open"
                            ? "running"
                            : pr.status === "merged"
                            ? "completed"
                            : "error"
                        }
                      />
                    </TableCell>
                    <TableCell>{pr.author}</TableCell>
                    <TableCell>
                      {formatDate(pr.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : displayPRs.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {displayPRs.map((pr, index) => (
            <div
              key={pr.id}
              className="grid-item hover-lift"
              style={{ animationDelay: `${index * 0.05}s` }}
            >
              <PRCard
                pr={pr}
                onClick={() => setSelectedPR(pr)}
              />
            </div>
          ))}
        </div>
      ) : null}

      <Dialog
        open={selectedPR !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedPR(null);
            setMergeError(null);
            setMergeSuccess(false);
          }
        }}
      >
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto zoom-in">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedPR?.status === "merged" ? (
                <GitMerge className="h-5 w-5 text-purple-500" />
              ) : (
                <GitPullRequest className="h-5 w-5 text-primary" />
              )}
              Pull Request #{selectedPR?.id}
            </DialogTitle>
            <DialogDescription>{selectedPR?.title}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-4 fade-in">
              <div>
                <h3 className="text-sm font-medium text-foreground mb-2">Branch</h3>
                <div className="flex items-center gap-2 text-sm text-foreground-muted">
                  <GitBranch className="h-4 w-4" />
                  <span>
                    {selectedPR?.branch} → {selectedPR?.baseBranch}
                  </span>
                </div>
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-2">Status</h3>
                <StatusChip
                  status={
                    selectedPR?.status === "open"
                      ? "running"
                      : selectedPR?.status === "merged"
                      ? "completed"
                      : "error"
                  }
                />
              </div>
            </div>
            <div className="fade-in" style={{ animationDelay: "0.1s" }}>
              <h3 className="text-sm font-medium text-foreground mb-2">Summary</h3>
              <p className="text-sm text-foreground-muted">{selectedPR?.summary}</p>
            </div>
            {selectedPR && state.prs.find((p) => p.number.toString() === selectedPR.id)?.html_url && (
              <div className="fade-in" style={{ animationDelay: "0.2s" }}>
                <h3 className="text-sm font-medium text-foreground mb-2">GitHub</h3>
                <a
                  href={state.prs.find((p) => p.number.toString() === selectedPR.id)?.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline text-sm"
                >
                  View on GitHub →
                </a>
              </div>
            )}
            
            {/* Merge PR Section */}
            {selectedPR && selectedPR.status === "open" && (
              <div className="fade-in border-t border-border pt-4 mt-4" style={{ animationDelay: "0.3s" }}>
                <h3 className="text-sm font-medium text-foreground mb-3">Actions</h3>
                {mergeSuccess ? (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-success/10 border border-success/20">
                    <CheckCircle2 className="h-4 w-4 text-success" />
                    <span className="text-sm text-success">Pull request merged successfully!</span>
                  </div>
                ) : (
                  <>
                    {mergeError && (
                      <Alert variant="destructive" className="mb-3">
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription className="text-sm">{mergeError}</AlertDescription>
                      </Alert>
                    )}
                    <Button
                      onClick={handleMergePR}
                      disabled={merging}
                      className="w-full gap-2"
                    >
                      {merging ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Merging...
                        </>
                      ) : (
                        <>
                          <GitMerge className="h-4 w-4" />
                          Merge Pull Request
                        </>
                      )}
                    </Button>
                    <p className="text-xs text-foreground-muted mt-2">
                      This will merge the pull request into the base branch ({selectedPR.baseBranch})
                    </p>
                  </>
                )}
              </div>
            )}
            
            {selectedPR && selectedPR.status === "merged" && (
              <div className="fade-in border-t border-border pt-4 mt-4" style={{ animationDelay: "0.3s" }}>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-success/10 border border-success/20">
                  <CheckCircle2 className="h-4 w-4 text-success" />
                  <span className="text-sm text-success font-medium">This pull request has been merged</span>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
