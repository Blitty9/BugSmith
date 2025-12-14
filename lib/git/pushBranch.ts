import { exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { join } from "path";

const execAsync = promisify(exec);

interface PushResult {
  success: boolean;
  message: string;
  remoteUrl?: string;
}

/**
 * Pushes a branch to the remote repository
 * @param repoPath - Absolute path to the repository
 * @param branchName - Name of the branch to push
 * @returns Push result with success status and message
 */
export async function pushBranch(
  repoPath: string,
  branchName: string
): Promise<PushResult> {
  try {
    // Check if we're in a serverless environment
    const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME;
    
    if (isServerless) {
      // In serverless, push will be handled via GitHub API
      console.log(`Serverless mode: Branch push will be handled via GitHub API`);
      return {
        success: true,
        message: "Branch push will be handled via GitHub API",
      };
    }

    // Validate repo path exists
    if (!existsSync(repoPath)) {
      throw new Error(`Repository path does not exist: ${repoPath}`);
    }

    if (!existsSync(join(repoPath, ".git"))) {
      throw new Error(`Not a valid git repository: ${repoPath}`);
    }

    // Check if remote exists
    try {
      const { stdout: remoteOutput } = await execAsync("git remote get-url origin", {
        cwd: repoPath,
      });
      const remoteUrl = remoteOutput.trim();
      console.log(`Pushing branch ${branchName} to ${remoteUrl}...`);

      // Push the branch
      const { stdout, stderr } = await execAsync(
        `git push origin ${branchName}`,
        { cwd: repoPath }
      );

      // Git often writes to stderr even on success
      if (stderr && !stderr.includes("To ") && !stderr.includes("branch")) {
        // Check for actual errors
        const errorIndicators = ["fatal:", "error:", "Permission denied", "Authentication failed"];
        if (errorIndicators.some((indicator) => stderr.toLowerCase().includes(indicator.toLowerCase()))) {
          throw new Error(`Git push error: ${stderr}`);
        }
      }

      console.log(`Successfully pushed branch ${branchName}`);
      return {
        success: true,
        message: `Successfully pushed branch ${branchName} to origin`,
        remoteUrl,
      };
    } catch (error: any) {
      // Check for authentication errors
      if (
        error.message?.includes("Authentication failed") ||
        error.message?.includes("Permission denied") ||
        error.message?.includes("403")
      ) {
        throw new Error(
          "GitHub authentication failed. Please ensure your GITHUB_TOKEN has write permissions or configure SSH keys."
        );
      }

      // Check if remote doesn't exist
      if (error.message?.includes("No such remote") || error.message?.includes("fatal: No remote")) {
        throw new Error("Remote 'origin' not found. Please configure the remote repository.");
      }

      throw error;
    }
  } catch (error: any) {
    console.error(`Error pushing branch ${branchName}:`, error);
    return {
      success: false,
      message: error.message || `Failed to push branch ${branchName}`,
    };
  }
}

