import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { platform } from "os";

const execAsync = promisify(exec);

/**
 * Clones or updates a GitHub repository to a local temp directory
 * For Vercel/serverless environments, uses GitHub API as fallback
 * @param repo - Repository in format "owner/repo"
 * @returns Absolute path to the cloned repository
 */
export async function cloneRepo(repo: string): Promise<string> {
  try {
    // Validate repo format
    const repoParts = repo.split("/");
    if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
      throw new Error(`Invalid repository format: ${repo}. Expected format: owner/repo`);
    }

    const [owner, repoName] = repoParts;

    // Check if we're in a serverless environment (Vercel, etc.)
    // Vercel sets VERCEL=1, AWS Lambda sets AWS_LAMBDA_FUNCTION_NAME
    // Also check if we're in /tmp (common serverless location) or if TEMP is not set
    let isServerless = 
      process.env.VERCEL === "1" || 
      process.env.VERCEL || 
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.VERCEL_ENV ||
      (!process.env.TEMP && !process.env.TMP && process.platform !== "win32");

    // If not detected as serverless, check if Git is available
    // This is a fallback in case environment variable detection fails
    if (!isServerless) {
      try {
        await execAsync("git --version", { maxBuffer: 1024 * 1024, timeout: 2000 });
        // Git is available, not serverless
      } catch (error) {
        // Git not available, treat as serverless
        console.log(`[cloneRepo] Git not available, using serverless mode`);
        isServerless = true;
      }
    }

    if (isServerless) {
      // In serverless, we can't clone repos, but we can create a mock structure
      // The actual file operations will use GitHub API
      const tempBase = "/tmp";
      const bugsmithDir = join(tempBase, "bugsmith");
      if (!existsSync(bugsmithDir)) {
        mkdirSync(bugsmithDir, { recursive: true });
      }

      const targetDir = join(bugsmithDir, `${owner}-${repoName}`);
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }

      // Create a marker file to indicate this is a serverless "clone"
      writeFileSync(
        join(targetDir, ".bugsmith-serverless"),
        JSON.stringify({ repo, cloned: false, serverless: true })
      );

      console.log(`Serverless mode: Created directory structure for ${repo} at ${targetDir}`);
      return targetDir;
    }

    // Determine temp directory based on OS
    const tempBase = platform() === "win32" 
      ? process.env.TEMP || process.env.TMP || "C:\\temp"
      : "/tmp";

    // Create bugsmith directory if it doesn't exist
    const bugsmithDir = join(tempBase, "bugsmith");
    if (!existsSync(bugsmithDir)) {
      mkdirSync(bugsmithDir, { recursive: true });
    }

    // Target directory for the repo
    const targetDir = join(bugsmithDir, `${owner}-${repoName}`);

    // Check if repo already exists
    if (existsSync(join(targetDir, ".git"))) {
      // Repo exists, try to update it
      try {
        await execAsync(`git -C "${targetDir}" pull`, {
          maxBuffer: 10 * 1024 * 1024,
        });
        console.log(`Updated existing repository ${repo}`);
        return targetDir;
      } catch (error: any) {
        // If pull fails, try to remove and re-clone
        console.warn(`Failed to update repository, will re-clone: ${error.message}`);
        // Note: We don't remove the directory here to avoid permission issues
        // The clone will fail if directory exists, which is handled below
      }
    }

    const repoUrl = `https://github.com/${owner}/${repoName}.git`;
    
    try {
      // Check if git is available
      try {
        await execAsync("git --version", { maxBuffer: 1024 * 1024 });
      } catch (gitCheckError) {
        throw new Error("Git is not installed or not in PATH. Please install Git to use this feature.");
      }

      const { stdout, stderr } = await execAsync(
        `git clone ${repoUrl} "${targetDir}"`,
        {
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large repos
        }
      );

      // Git often writes to stderr even on success, but check for actual errors
      if (stderr && !stderr.includes("Cloning into") && !stderr.includes("remote:")) {
        // Check if it's a real error (not just progress messages)
        const errorIndicators = ["fatal:", "error:", "Permission denied", "not found"];
        if (errorIndicators.some((indicator) => stderr.toLowerCase().includes(indicator.toLowerCase()))) {
          throw new Error(`Git clone error: ${stderr}`);
        }
      }
    } catch (error: any) {
      // Check if error is because git is not installed
      if (error.message?.includes("git") && (error.message?.includes("not found") || error.message?.includes("not in PATH"))) {
        throw new Error("Git is not installed or not in PATH. Please install Git to use this feature.");
      }
      throw error;
    }

    console.log(`Successfully cloned repository ${repo} to ${targetDir}`);
    return targetDir;
  } catch (error: any) {
    console.error(`Error cloning repository ${repo}:`, error);
    throw new Error(
      `Failed to clone repository ${repo}: ${error.message || "Unknown error"}`
    );
  }
}
