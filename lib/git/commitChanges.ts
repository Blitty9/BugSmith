import { exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { join } from "path";

const execAsync = promisify(exec);

interface CommitResult {
  success: boolean;
  commitHash?: string;
  message: string;
}

/**
 * Stages and commits all changes in the repository
 * @param repoPath - Absolute path to the repository
 * @param issueNumber - Issue number for commit message
 * @returns Commit result with hash and message
 */
export async function commitChanges(
  repoPath: string,
  issueNumber: number | string
): Promise<CommitResult> {
  try {
    // Check if we're in a serverless environment
    const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME;
    
    if (isServerless) {
      // In serverless, commits will be handled via GitHub API
      console.log(`Serverless mode: Commit will be created via GitHub API`);
      return {
        success: true,
        message: "Commit will be created via GitHub API",
      };
    }

    // Validate repo path exists
    if (!existsSync(repoPath)) {
      throw new Error(`Repository path does not exist: ${repoPath}`);
    }

    if (!existsSync(join(repoPath, ".git"))) {
      throw new Error(`Not a valid git repository: ${repoPath}`);
    }

    // Check if there are any changes to commit
    try {
      const { stdout: statusOutput } = await execAsync("git status --porcelain", {
        cwd: repoPath,
      });

      if (!statusOutput.trim()) {
        return {
          success: true,
          message: "No changes to commit",
        };
      }
    } catch (error: any) {
      throw new Error(`Failed to check git status: ${error.message}`);
    }

    // Stage all changes
    console.log(`Staging changes in ${repoPath}...`);
    try {
      await execAsync("git add .", { cwd: repoPath });
    } catch (error: any) {
      throw new Error(`Failed to stage changes: ${error.message}`);
    }

    // Commit changes
    const commitMessage = `BugSmith automated fix for issue #${issueNumber}`;
    console.log(`Committing changes with message: ${commitMessage}`);

    try {
      const { stdout } = await execAsync(
        `git commit -m "${commitMessage}"`,
        { cwd: repoPath }
      );

      // Extract commit hash from output or get it separately
      const { stdout: hashOutput } = await execAsync("git rev-parse HEAD", {
        cwd: repoPath,
      });

      const commitHash = hashOutput.trim();

      return {
        success: true,
        commitHash,
        message: `Successfully committed changes: ${commitHash.substring(0, 7)}`,
      };
    } catch (error: any) {
      // Check if commit failed because there's nothing to commit
      if (error.message.includes("nothing to commit")) {
        return {
          success: true,
          message: "No changes to commit (files may have been staged but not modified)",
        };
      }
      throw new Error(`Failed to commit changes: ${error.message}`);
    }
  } catch (error: any) {
    console.error(`Error committing changes:`, error);
    return {
      success: false,
      message: error.message || "Failed to commit changes",
    };
  }
}

