import "@/lib/loadEnv";

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { cloneRepo } from "@/lib/git/cloneRepo";
import { createBranch } from "@/lib/git/createBranch";
import { createBranch as createBranchViaAPI } from "@/lib/github/apiOperations";

interface PrepareRepoRequest {
  repo: string;
  issueNumber: number;
}

export async function POST(request: NextRequest) {
  try {
    const body: PrepareRepoRequest = await request.json();
    const { repo, issueNumber } = body;

    // Validate required fields
    if (!repo || !issueNumber) {
      return NextResponse.json(
        { error: "Missing required fields: repo and issueNumber are required" },
        { status: 400 }
      );
    }

    // Validate repo format
    const repoParts = repo.split("/");
    if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
      return NextResponse.json(
        { error: "Invalid repository format. Use owner/repo (e.g., vercel/next.js)" },
        { status: 400 }
      );
    }

    // Check if we're in a serverless environment
    // Vercel sets VERCEL=1, AWS Lambda sets AWS_LAMBDA_FUNCTION_NAME
    // Also check if Git is available - if not, use serverless mode
    let isServerless = 
      process.env.VERCEL === "1" || 
      process.env.VERCEL || 
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.VERCEL_ENV;
    
    // If not detected as serverless, check if Git is available
    if (!isServerless) {
      try {
        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        const execAsync = promisify(exec);
        await execAsync("git --version", { timeout: 2000 });
        // Git is available, not serverless
      } catch (error) {
        // Git not available, treat as serverless
        console.log(`[DEBUG] Git not available, using serverless mode`);
        isServerless = true;
      }
    }
    
    console.log(`[DEBUG] Serverless detection: VERCEL=${process.env.VERCEL}, isServerless=${isServerless}`);
    const branchName = `bugsmith-fix-${issueNumber}`;

    if (isServerless) {
      // In serverless, create branch via GitHub API
      console.log(`Serverless mode: Creating branch via GitHub API...`);
      const branchResult = await createBranchViaAPI(repo, branchName);
      
      if (!branchResult.success && !branchResult.error?.includes("already exists")) {
        return NextResponse.json(
          { error: `Failed to create branch: ${branchResult.error}` },
          { status: 500 }
        );
      }

      // Return a mock repo path for serverless (won't be used for file operations)
      const repoPath = `/tmp/bugsmith/${repo.replace("/", "-")}`;
      
      return NextResponse.json({
        repoPath,
        branchName,
        success: true,
      });
    } else {
      // Clone or update the repository (only if Git is available)
      let repoPath: string;
      try {
        repoPath = await cloneRepo(repo);

      // Create branch for the fix
      try {
        await createBranch(repoPath, branchName);
      } catch (error: any) {
        return NextResponse.json(
          { error: `Failed to create branch: ${error.message}` },
          { status: 500 }
        );
      }

      // Return success with repo path and branch name
      return NextResponse.json({
        repoPath,
        branchName,
        success: true,
      });
    }
  } catch (error: any) {
    console.error("Error preparing repository:", error);
    return NextResponse.json(
      { error: `Failed to prepare repository: ${error.message || "Unknown error"}` },
      { status: 500 }
    );
  }
}

