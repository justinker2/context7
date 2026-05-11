import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";

const IMAGE_PREFIX = process.env.CTX7_BENCH_IMAGE_PREFIX ?? "ctx7-bench";

export type ImageVariant = "base" | "claudecode";

export function imageFor(pythonVersion: string, variant: ImageVariant = "base"): string {
  const py = `py${pythonVersion.replace(".", "")}`;
  const suffix = variant === "claudecode" ? "-cc" : "";
  return `${IMAGE_PREFIX}:${py}${suffix}`;
}

export interface SandboxStartOpts {
  pythonVersion: string;
  library: string;
  version: string;
  additionalDeps?: string;
  setupTimeoutSec?: number;
  variant?: ImageVariant;
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const DEFAULT_EXEC_TIMEOUT = 30;

// Long-lived per-cell sandbox. Backs the agentic loop's tool calls and the
// pass@1 / AST scorers. /work on the host is bind-mounted at /work in the
// container; agent file ops are direct host writes (no docker round-trip).
// Test files for the eval phase are docker-cp'd into a separate /eval dir
// after the agent loop ends, so the agent never sees them.
export class Sandbox {
  private constructor(
    private readonly container: string,
    public readonly workdir: string,
    public readonly opts: SandboxStartOpts
  ) {}

  static async start(opts: SandboxStartOpts): Promise<Sandbox> {
    const workdir = await mkdtemp(join(tmpdir(), "ctx7-bench-"));
    const container = `ctx7-bench-${randomUUID().slice(0, 12)}`;
    const image = imageFor(opts.pythonVersion, opts.variant);

    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      envArgs.push("-e", `${k}=${v}`);
    }

    // Spin up the container; sleep so docker exec works for the cell's lifetime.
    const create = await execa(
      "docker",
      [
        "run",
        "-d",
        "--name",
        container,
        "-v",
        `${workdir}:/work`,
        "-w",
        "/work",
        ...envArgs,
        image,
        "sleep",
        "infinity",
      ],
      { reject: false }
    );
    if (create.exitCode !== 0) {
      await rm(workdir, { recursive: true, force: true });
      throw new Error(`docker run failed (${create.exitCode}): ${create.stderr}`);
    }

    const sb = new Sandbox(container, workdir, opts);

    try {
      // Pre-create the eval dir so docker cp targets work later.
      await sb.exec("mkdir -p /eval", { timeoutSec: 10 });

      const pkgs = [`${opts.library}==${opts.version}`];
      if (opts.additionalDeps?.trim()) pkgs.push(opts.additionalDeps.trim());
      const pip = `pip install --quiet --no-input ${pkgs.map(quote).join(" ")}`;
      const setup = await sb.exec(pip, { timeoutSec: opts.setupTimeoutSec ?? 300 });
      if (setup.exitCode !== 0) {
        throw new Error(
          `setup pip install failed (${setup.exitCode}): ${setup.stderr.slice(0, 800)}`
        );
      }
    } catch (err) {
      await sb.stop();
      throw err;
    }

    return sb;
  }

  async exec(cmd: string, { timeoutSec = DEFAULT_EXEC_TIMEOUT } = {}): Promise<ExecResult> {
    const started = Date.now();
    const proc = await execa("docker", ["exec", this.container, "bash", "-c", cmd], {
      timeout: timeoutSec * 1000,
      reject: false,
    });
    return {
      exitCode: proc.exitCode ?? -1,
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
      durationMs: Date.now() - started,
      timedOut: Boolean(proc.timedOut),
    };
  }

  // Write to /work via the host mount — no docker round-trip needed.
  async writeWorkFile(name: string, content: string): Promise<void> {
    safeName(name);
    await writeFile(join(this.workdir, name), content, "utf8");
  }

  async readWorkFile(name: string): Promise<string | null> {
    safeName(name);
    try {
      return await readFile(join(this.workdir, name), "utf8");
    } catch {
      return null;
    }
  }

  async listWorkFiles(): Promise<string[]> {
    try {
      return await readdir(this.workdir);
    } catch {
      return [];
    }
  }

  async workFileExists(name: string): Promise<boolean> {
    safeName(name);
    try {
      await stat(join(this.workdir, name));
      return true;
    } catch {
      return false;
    }
  }

  // Copy a host-side file into the container at any absolute path.
  // Used to drop hidden test code into /eval/ after the agent loop ends.
  async copyIn(hostPath: string, containerPath: string): Promise<void> {
    const r = await execa("docker", ["cp", hostPath, `${this.container}:${containerPath}`], {
      reject: false,
    });
    if (r.exitCode !== 0) {
      throw new Error(`docker cp failed: ${r.stderr}`);
    }
  }

  // Convenience: write a file directly into a container path (e.g. /eval/test.py).
  async writeContainerFile(containerPath: string, content: string): Promise<void> {
    const tmpPath = join(this.workdir, `.copyin-${randomUUID().slice(0, 8)}`);
    await writeFile(tmpPath, content, "utf8");
    try {
      await this.copyIn(tmpPath, containerPath);
    } finally {
      await rm(tmpPath, { force: true });
    }
  }

  async stop(): Promise<void> {
    await execa("docker", ["rm", "-f", this.container], { reject: false });
    await rm(this.workdir, { recursive: true, force: true });
  }
}

function safeName(name: string): void {
  if (name.includes("..") || name.startsWith("/") || name.includes("\0")) {
    throw new Error(`unsafe file name: ${name}`);
  }
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
