"use client";

import { useState, useRef, useEffect } from "react";
import { IssueCard, type Issue } from "@/components/issue-card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Github, Loader2, AlertCircle, Clock, X } from "lucide-react";
import { formatDateTime } from "@/lib/utils";
import { useAgent } from "@/contexts/agent-context";
import { useRecentRepos } from "@/lib/hooks/useRecentRepos";

interface GitHubIssue {
  id: string;
  number: number;
  title: string;
  state: string;
  labels: string[];
  created_at: string;
  html_url: string;
}

/**
 * Maps GitHub API issue response to our Issue format
 */
function mapGitHubIssueToIssue(githubIssue: GitHubIssue): Issue {
  // Determine difficulty based on labels
  let difficulty: "easy" | "medium" | "hard" = "medium";
  const labelsLower = githubIssue.labels.map((l) => l.toLowerCase());
  if (labelsLower.some((l) => l.includes("good first") || l.includes("easy"))) {
    difficulty = "easy";
  } else if (labelsLower.some((l) => l.includes("hard") || l.includes("complex"))) {
    difficulty = "hard";
  }

  return {
    id: githubIssue.id,
    title: githubIssue.title,
    difficulty,
    status: githubIssue.state === "open" ? "open" : "resolved",
    createdAt: githubIssue.created_at,
    labels: githubIssue.labels,
    number: githubIssue.number,
    html_url: githubIssue.html_url,
  };
}

export default function IssuesPage() {
  const { state, setIssues, setCurrentRepo, setCurrentIssue } = useAgent();
  const { recentRepos, addRecentRepo, clearRecentRepos } = useRecentRepos();
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [repoInput, setRepoInput] = useState("");
  const [issues, setLocalIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayedRepo, setDisplayedRepo] = useState<string | null>(null);
  const [showRecentRepos, setShowRecentRepos] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setShowRecentRepos(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const fetchIssues = async () => {
    if (!repoInput.trim()) {
      setError("Please enter a repository name (e.g., vercel/next.js)");
      return;
    }

    setLoading(true);
    setError(null);
    setShowRecentRepos(false);

    try {
      const response = await fetch(`/api/github/issues?repo=${encodeURIComponent(repoInput.trim())}`);
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Failed to fetch issues");
        setLocalIssues([]);
        setIssues([]); // Clear in context too
        return;
      }

      const formattedIssues = data.map(mapGitHubIssueToIssue);
      setLocalIssues(formattedIssues);
      setIssues(formattedIssues); // Sync with agent context
      const trimmedRepo = repoInput.trim();
      setCurrentRepo(trimmedRepo); // Sync with agent context
      setDisplayedRepo(trimmedRepo); // Update displayed repo
      
      // Save to recent repos on successful fetch
      addRecentRepo(trimmedRepo);
      
      if (formattedIssues.length > 0) {
        setCurrentIssue(formattedIssues[0]); // Set first issue as current
      }
    } catch (err) {
      setError("Failed to fetch issues. Please check your connection and try again.");
      setLocalIssues([]);
      setIssues([]); // Clear in context too
    } finally {
      setLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      fetchIssues();
    } else if (e.key === "Escape") {
      setShowRecentRepos(false);
    }
  };

  const handleRepoSelect = (repo: string) => {
    setRepoInput(repo);
    setShowRecentRepos(false);
    inputRef.current?.focus();
  };

  const allIssues = issues.length > 0 ? issues : state.issues;
  const filteredIssues = allIssues.filter(
    (issue) =>
      issue.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      issue.id.includes(searchQuery) ||
      (issue.number && issue.number.toString().includes(searchQuery))
  );

  return (
    <div className="p-6 space-y-6">
      {/* Header with fade-in */}
      <div className="flex items-center justify-between fade-in-up">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Issues</h1>
          <p className="text-foreground-muted mt-1">
            GitHub issues ready for agent processing
          </p>
        </div>
      </div>

      {/* Repository Input with slide-in */}
      <div className="flex gap-2 fade-in-left relative z-10">
        <div className="flex-1 relative">
          <Github className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-muted z-10" />
          <Input
            ref={inputRef}
            type="text"
            placeholder="Enter repository (e.g., vercel/next.js)"
            value={repoInput}
            onChange={(e) => {
              setRepoInput(e.target.value);
              // Show dropdown when typing if there are recent repos
              if (recentRepos.length > 0) {
                setShowRecentRepos(true);
              }
            }}
            onKeyPress={handleKeyPress}
            onFocus={() => {
              if (recentRepos.length > 0) {
                setShowRecentRepos(true);
              }
            }}
            onClick={() => {
              if (recentRepos.length > 0) {
                setShowRecentRepos(true);
              }
            }}
            className="pl-9 relative z-10"
          />
          
          {/* Recent Repos Dropdown */}
          {showRecentRepos && recentRepos.length > 0 && (
            <div
              ref={dropdownRef}
              className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-xl z-[200] overflow-hidden slide-down"
            >
              <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                <span className="text-xs font-medium text-foreground-muted">Recent Repositories</span>
                <button
                  onClick={clearRecentRepos}
                  className="text-xs text-foreground-muted hover:text-foreground transition-colors"
                  title="Clear all"
                >
                  Clear
                </button>
              </div>
              <div className="max-h-60 overflow-y-auto">
                {recentRepos.map((repo, index) => (
                  <button
                    key={repo}
                    onClick={() => handleRepoSelect(repo)}
                    className="w-full px-3 py-2.5 text-left text-sm text-foreground hover:bg-muted transition-colors flex items-center justify-between group fade-in"
                    style={{ animationDelay: `${index * 0.05}s` }}
                  >
                    <div className="flex items-center gap-2">
                      <Github className="h-4 w-4 text-foreground-muted" />
                      <span className="font-medium">{repo}</span>
                    </div>
                    <Clock className="h-3.5 w-3.5 text-foreground-muted/50 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <Button onClick={fetchIssues} disabled={loading} className="hover-scale">
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Fetching...
            </>
          ) : (
            <>
              <Github className="mr-2 h-4 w-4" />
              Fetch Issues
            </>
          )}
        </Button>
      </div>

      {displayedRepo && (
        <div className="text-sm text-foreground-muted fade-in">
          Showing issues from: <span className="text-foreground font-medium">{displayedRepo}</span>
        </div>
      )}

      {error && (
        <Alert variant="destructive" className="fade-in-up">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!loading && issues.length === 0 && state.issues.length === 0 && !error && (
        <div className="rounded-md border border-border bg-background p-8 text-center fade-in-up relative z-0">
          <Github className="h-12 w-12 text-foreground-muted mx-auto mb-4" />
          <p className="text-foreground-muted">
            Enter a repository name above and click &quot;Fetch Issues&quot; to load GitHub issues.
          </p>
        </div>
      )}

      {/* Search with fade-in */}
      {issues.length > 0 && (
        <div className="relative fade-in-left">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-muted" />
          <Input
            type="search"
            placeholder="Search issues..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 w-full max-w-md"
          />
        </div>
      )}

      {/* Issues Grid with staggered animations */}
      {(issues.length > 0 || state.issues.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredIssues.map((issue, index) => (
            <div
              key={issue.id}
              className="grid-item hover-lift"
              style={{ animationDelay: `${index * 0.05}s` }}
            >
              <IssueCard
                issue={issue}
                onClick={() => {
                  setSelectedIssue(issue);
                  setCurrentIssue(issue); // Update agent context when issue is selected
                }}
              />
            </div>
          ))}
        </div>
      )}

      {(issues.length > 0 || state.issues.length > 0) && filteredIssues.length === 0 && (
        <div className="text-center text-foreground-muted py-8 fade-in">
          No issues match your search query.
        </div>
      )}

      {/* Issue Detail Dialog */}
      <Dialog
        open={selectedIssue !== null}
        onOpenChange={(open) => !open && setSelectedIssue(null)}
      >
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto zoom-in">
          <DialogHeader>
            <DialogTitle>Issue #{selectedIssue?.number || selectedIssue?.id}</DialogTitle>
            <DialogDescription>{selectedIssue?.title}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="fade-in">
              <h3 className="text-sm font-medium text-foreground mb-2">Details</h3>
              <div className="space-y-2 text-sm text-foreground-muted">
                <div className="flex justify-between">
                  <span>Status:</span>
                  <span className="text-foreground capitalize">{selectedIssue?.status}</span>
                </div>
                <div className="flex justify-between">
                  <span>Difficulty:</span>
                  <span className="text-foreground capitalize">{selectedIssue?.difficulty}</span>
                </div>
                <div className="flex justify-between">
                  <span>Created:</span>
                  <span className="text-foreground">
                    {selectedIssue
                      ? formatDateTime(selectedIssue.createdAt)
                      : ""}
                  </span>
                </div>
                {selectedIssue?.user && (
                  <div className="flex justify-between">
                    <span>Author:</span>
                    <span className="text-foreground">{selectedIssue.user}</span>
                  </div>
                )}
                {selectedIssue?.html_url && (
                  <div className="flex justify-between">
                    <span>GitHub:</span>
                    <a
                      href={selectedIssue.html_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      View on GitHub
                    </a>
                  </div>
                )}
              </div>
            </div>
            {selectedIssue?.body && (
              <div className="fade-in" style={{ animationDelay: "0.1s" }}>
                <h3 className="text-sm font-medium text-foreground mb-2">Description</h3>
                <div className="rounded-md border border-border bg-background p-4">
                  <div className="text-sm text-foreground-muted whitespace-pre-wrap">
                    {selectedIssue.body}
                  </div>
                </div>
              </div>
            )}
            {selectedIssue?.labels && selectedIssue.labels.length > 0 && (
              <div className="fade-in" style={{ animationDelay: "0.2s" }}>
                <h3 className="text-sm font-medium text-foreground mb-2">Labels</h3>
                <div className="flex flex-wrap gap-2">
                  {selectedIssue.labels.map((label) => (
                    <span
                      key={label}
                      className="rounded-md bg-muted px-2 py-1 text-xs text-foreground-muted hover-scale"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
