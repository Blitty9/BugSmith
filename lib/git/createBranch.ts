import { exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { join } from "path";

const execAsync = promisify(exec);

/**
 * Creates a new git branch or checks out existing branch
 * @param repoPath - Absolute path to the repository
 * @param branchName - Name of the branch to create or checkout
 * @returns Success message
 */
export async function createBranch(repoPath: string, branchName: string): Promise<string> {
  try {
    // Check if we're in a serverless environment
    const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME;
    
    if (isServerless) {
      // In serverless, we can't create branches with Git
      // This will be handled via GitHub API in the applyFix route
      console.log(`Serverless mode: Branch ${branchName} will be created via GitHub API`);
      return `Branch ${branchName} will be created via GitHub API`;
    }

    // Validate repo path exists
    if (!existsSync(repoPath)) {
      throw new Error(`Repository path does not exist: ${repoPath}`);
    }

    if (!existsSync(join(repoPath, ".git"))) {
      throw new Error(`Not a valid git repository: ${repoPath}`);
    }

    // Check if branch already exists
    try {
      const { stdout } = await execAsync(
        `git branch --list ${branchName}`,
        { cwd: repoPath }
      );

      if (stdout.trim()) {
        // Branch exists, checkout it
        console.log(`Branch ${branchName} already exists. Checking out...`);
        await execAsync(`git checkout ${branchName}`, { cwd: repoPath });
        return `Checked out existing branch: ${branchName}`;
      }
    } catch (error: any) {
      // Branch doesn't exist, continue to create it
    }

    // Create new branch from current branch (usually main/master)
    console.log(`Creating new branch: ${branchName}`);
    
    // First, ensure we're on main or master
    let baseBranch = "main";
    try {
      await execAsync("git checkout main", { cwd: repoPath });
    } catch {
      try {
        await execAsync("git checkout master", { cwd: repoPath });
        baseBranch = "master";
      } catch {
        // If neither exists, try to get current branch
        try {
          const { stdout } = await execAsync("git branch --show-current", { cwd: repoPath });
          if (stdout.trim()) {
            baseBranch = stdout.trim();
          } else {
            throw new Error("Could not determine base branch. Repository may be empty.");
          }
        } catch (error: any) {
          throw new Error("Could not determine base branch. Repository may be empty.");
        }
      }
    }

    // Create and checkout new branch
    await execAsync(`git checkout -b ${branchName}`, { cwd: repoPath });
    
    console.log(`Successfully created and checked out branch: ${branchName}`);
    return `Created branch: ${branchName}`;
  } catch (error: any) {
    console.error(`Error creating branch ${branchName}:`, error);
    throw new Error(
      `Failed to create branch ${branchName}: ${error.message || "Unknown error"}`
    );
  }
}

