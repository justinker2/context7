import type { Sandbox } from "../sandbox.js";
import type { PassAt1Score, Sample } from "../types.js";

const TEST_HARNESS = `
import sys, traceback, runpy
try:
    ns = runpy.run_path("/work/solution.py", run_name="__solution__")
except Exception:
    traceback.print_exc()
    sys.exit(2)
try:
    src = open("/eval/test_solution.py").read()
    exec(compile(src, "test_solution.py", "exec"), ns)
except SystemExit:
    raise
except BaseException:
    traceback.print_exc()
    sys.exit(1)
sys.exit(0)
`;

export async function scorePassAt1(sample: Sample, sandbox: Sandbox): Promise<PassAt1Score> {
  const started = Date.now();

  await sandbox.writeContainerFile("/eval/test_solution.py", sample.row.test);
  await sandbox.writeContainerFile("/eval/harness.py", TEST_HARNESS);

  if (!(await sandbox.workFileExists("solution.py"))) {
    return {
      passed: false,
      exitCode: -1,
      stdout: "",
      stderr: "no /work/solution.py produced by solver",
      durationMs: Date.now() - started,
    };
  }

  const r = await sandbox.exec("python /eval/harness.py", { timeoutSec: 60 });
  return {
    passed: r.exitCode === 0,
    exitCode: r.exitCode,
    stdout: r.stdout.slice(-4000),
    stderr: r.stderr.slice(-4000),
    durationMs: Date.now() - started,
  };
}
