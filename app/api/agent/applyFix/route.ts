import "@/lib/loadEnv";

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { generatePatch } from "@/lib/ai/generatePatch";
import { applyPatch } from "@/lib/git/applyPatch";
import { commitChanges } from "@/lib/git/commitChanges";
import { pushBranch } from "@/lib/git/pushBranch";
import { applyPatchViaAPI, createBranch as createBranchViaAPI, getFiles } from "@/lib/github/apiOperations";
import { readdirSync, statSync } from "fs";
import { join, resolve, relative } from "path";

interface ApplyFixRequest {
  repo: string;
  repoPath: string;
  branchName: string;
  issue: {
    id: string;
    number?: number;
    title: string;
    status: string;
    labels?: string[];
    body?: string;
  };
  preview?: boolean;
  regenerate?: boolean;
  useFuzzy?: boolean;
}

/**
 * Finds relevant code files in the repository
 * For now, scans for .js/.ts files, can be refined later
 */
async function findRelevantFiles(repoPath: string): Promise<string[]> {
  const files: string[] = [];
  const absoluteRepoPath = resolve(repoPath);
  
  function scanDirectory(dir: string, basePath: string) {
    try {
      const entries = readdirSync(dir);
      
      for (const entry of entries) {
        // Skip hidden files, node_modules, .git, etc.
        if (entry.startsWith(".") && entry !== ".env" && entry !== ".env.local") {
          continue;
        }
        if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "build") {
          continue;
        }
        
        const fullPath = join(dir, entry);
        const relativePath = relative(absoluteRepoPath, fullPath);
        
        try {
          const stat = statSync(fullPath);
          
          if (stat.isDirectory()) {
            scanDirectory(fullPath, basePath);
          } else if (stat.isFile()) {
            // Include .js, .ts, .jsx, .tsx files
            if (/\.(js|ts|jsx|tsx)$/i.test(entry)) {
              files.push(relativePath.replace(/\\/g, "/"));
            }
          }
        } catch {
          // Skip files we can't access
          continue;
        }
      }
    } catch {
      // Skip directories we can't access
    }
  }
  
  scanDirectory(absoluteRepoPath, absoluteRepoPath);
  
  // Limit to first 10 files to avoid token limits
  return files.slice(0, 10);
}


export async function POST(request: NextRequest) {
  try {
    let body: ApplyFixRequest;
    try {
      body = await request.json();
    } catch (parseError) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request body. Expected JSON.",
          patch: undefined,
          modifiedFiles: [],
          commitHash: undefined,
        },
        { 
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
    
    const { repo, repoPath, branchName, issue, preview = false, regenerate = false } = body;

    // Validate required fields
    if (!repo || !repoPath || !branchName || !issue) {
      return NextResponse.json(
        { 
          success: false,
          error: "Missing required fields: repo, repoPath, branchName, and issue are required",
          patch: undefined,
          modifiedFiles: [],
          commitHash: undefined,
        },
        { 
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Check if we're in a serverless environment
    // Vercel sets VERCEL=1, AWS Lambda sets AWS_LAMBDA_FUNCTION_NAME
    const isServerless = 
      process.env.VERCEL === "1" || 
      process.env.VERCEL || 
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.VERCEL_ENV;
    
    console.log(`[DEBUG] Serverless detection: VERCEL=${process.env.VERCEL}, isServerless=${isServerless}`);

    // Step 1: Identify relevant files
    console.log(`Finding relevant files for issue #${issue.number || issue.id}...`);
    let relevantFiles: string[];
    
    if (isServerless) {
      // In serverless, list files from GitHub API
      try {
        const { listCodeFiles } = await import("@/lib/github/apiOperations");
        relevantFiles = await listCodeFiles(repo, branchName, "", 20);
        console.log(`Serverless mode: Found ${relevantFiles.length} code files via GitHub API`);
        
        if (relevantFiles.length === 0) {
          return NextResponse.json({
            success: false,
            error: "No code files found in repository",
            patch: undefined,
            modifiedFiles: [],
            commitHash: undefined,
          }, {
            headers: { "Content-Type": "application/json" },
          });
        }
      } catch (error: any) {
        console.error(`Failed to list files from GitHub:`, error);
        return NextResponse.json({
          success: false,
          error: `Failed to discover files: ${error.message || "Unknown error"}`,
          patch: undefined,
          modifiedFiles: [],
          commitHash: undefined,
        }, {
          headers: { "Content-Type": "application/json" },
        });
      }
    } else {
      relevantFiles = await findRelevantFiles(repoPath);
      
      if (relevantFiles.length === 0) {
        return NextResponse.json({
          success: false,
          error: "No relevant code files found in repository",
          patch: undefined,
          modifiedFiles: [],
          commitHash: undefined,
        }, {
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    console.log(`Found ${relevantFiles.length} relevant files: ${relevantFiles.join(", ")}`);

    // Step 2: Generate patch using OpenAI
    if (regenerate) {
      console.log(`Regenerating patch for issue #${issue.number || issue.id} (retry attempt)...`);
    } else {
      console.log(`Generating patch for issue #${issue.number || issue.id}...`);
    }
    console.log("[DEBUG] Using OpenAI Projects API");
    console.log("[DEBUG] OpenAI key loaded:", !!process.env.OPENAI_KEY);
    console.log("[DEBUG] OpenAI key length:", process.env.OPENAI_KEY?.length || 0);
    let patch: string;
    try {
      patch = await generatePatch({
        repoPath,
        issue: issue as any,
        files: relevantFiles,
        repo: isServerless ? repo : undefined,
        branch: branchName,
      });
    } catch (error: any) {
      console.error("Error generating patch:", error);
      const errorMessage = error?.message || error?.toString() || "Unknown error";
      
      return NextResponse.json(
        {
          success: false,
          error: `Failed to generate patch: ${errorMessage}`,
          patch: undefined,
          modifiedFiles: [],
          commitHash: undefined,
        },
        { 
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // If preview mode, return patch without applying
    if (preview) {
      // Parse patch to get file list
      const filePaths = patch
        .split("\n")
        .filter((line) => line.startsWith("--- a/") || line.startsWith("+++ b/"))
        .map((line) => line.replace(/^--- a\//, "").replace(/^\+\+\+ b\//, ""))
        .filter((path) => path && !path.startsWith("/dev/null"))
        .filter((value, index, self) => self.indexOf(value) === index);

      return NextResponse.json({
        success: true,
        patch,
        modifiedFiles: filePaths,
        preview: true,
        message: "Patch generated in preview mode",
      });
    }

    // Step 3: Apply patch
    console.log(`Applying patch...`);
    let patchResult: {
      success: boolean;
      modifiedFiles: string[];
      error?: string;
      commitHash?: string;
    };
    
    if (isServerless) {
      // Use GitHub API to apply patch
      console.log(`Serverless mode: Applying patch via GitHub API...`);
      
      // Ensure branch exists
      const branchResult = await createBranchViaAPI(repo, branchName);
      if (!branchResult.success && !branchResult.error?.includes("already exists")) {
        return NextResponse.json(
          {
            success: false,
            error: `Failed to create branch: ${branchResult.error}`,
            patch,
            modifiedFiles: [],
            commitHash: undefined,
          },
          { status: 500 }
        );
      }

      patchResult = await applyPatchViaAPI(repo, patch, branchName, issue.number || issue.id);
    } else {
      // Use Git commands
      const gitResult = await applyPatch(repoPath, patch);
      patchResult = {
        success: gitResult.success,
        modifiedFiles: gitResult.modifiedFiles,
        error: gitResult.error,
      };
    }

    if (!patchResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: patchResult.error || "Failed to apply patch",
          patch,
          modifiedFiles: [],
          commitHash: undefined,
        },
        { status: 500 }
      );
    }

    if (patchResult.modifiedFiles.length === 0) {
      return NextResponse.json({
        success: true,
        patch,
        modifiedFiles: [],
        message: "Patch generated but no files were modified.",
        commitHash: undefined,
        pushed: false,
      });
    }

    console.log(`Modified files: ${patchResult.modifiedFiles.join(", ")}`);

    // Step 4 & 5: Commit and push (handled by GitHub API in serverless, or Git commands locally)
    if (isServerless) {
      // GitHub API already committed the changes when updating files
      // Return success
      return NextResponse.json({
        success: true,
        patch,
        modifiedFiles: patchResult.modifiedFiles,
        commitHash: patchResult.commitHash,
        pushed: true,
        message: `Successfully generated patch, applied changes, and committed to ${branchName} via GitHub API`,
      });
    } else {
      // Use Git commands
      // Step 4: Commit changes
      console.log(`Committing changes for issue #${issue.number || issue.id}...`);
      const commitResult = await commitChanges(repoPath, issue.number || issue.id);

      if (!commitResult.success) {
        return NextResponse.json(
          {
            success: false,
            error: `Failed to commit changes: ${commitResult.message}`,
            patch,
            modifiedFiles: patchResult.modifiedFiles,
            commitHash: undefined,
          },
          { status: 500 }
        );
      }

      // Step 5: Push branch
      console.log(`Pushing branch ${branchName}...`);
      const pushResult = await pushBranch(repoPath, branchName);

      if (!pushResult.success) {
        return NextResponse.json(
          {
            success: false,
            error: `Failed to push branch: ${pushResult.message}`,
            patch,
            modifiedFiles: patchResult.modifiedFiles,
            commitHash: commitResult.commitHash,
            pushed: false,
          },
          { status: 500 }
        );
      }

      // Return success
      return NextResponse.json({
        success: true,
        patch,
        modifiedFiles: patchResult.modifiedFiles,
        commitHash: commitResult.commitHash,
        pushed: true,
        message: `Successfully generated patch, applied changes, committed, and pushed to ${branchName}`,
      });
    }
  } catch (error: any) {
    console.error("Error applying fix:", error);
    const errorMessage = error.message || "Unknown error";
    
    // Ensure we always return valid JSON
    return NextResponse.json(
      { 
        success: false,
        error: `Failed to apply fix: ${errorMessage}`,
        patch: undefined,
        modifiedFiles: [],
        commitHash: undefined,
      },
      { 
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}
