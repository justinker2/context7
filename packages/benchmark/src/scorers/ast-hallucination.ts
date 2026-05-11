import type { Sandbox } from "../sandbox.js";
import type { AstHallucinationScore, Sample } from "../types.js";

// Static check: parse /work/solution.py, walk every attribute chain rooted at
// an imported module, resolve via getattr against the actually installed
// package. Unresolved chains are flagged.
//
// Known limitation: cannot follow chains rooted at local variables (would
// require type inference). Catches module-level hallucinations — the most
// common failure mode for stale-training-data models.
const AST_CHECK = `
import ast, importlib, json, sys

with open("/work/solution.py") as f:
    src = f.read()

try:
    tree = ast.parse(src)
except SyntaxError as e:
    print(json.dumps({"syntax_error": f"{e.__class__.__name__}: {e}", "unresolved": [], "checked": 0}))
    sys.exit(0)

imports = {}
from_targets = []

for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            local = alias.asname or alias.name.split(".")[0]
            imports[local] = alias.name
    elif isinstance(node, ast.ImportFrom):
        if not node.module:
            continue
        names = []
        for alias in node.names:
            local = alias.asname or alias.name
            names.append((local, alias.name))
            if alias.name != "*":
                imports[local] = f"{node.module}.{alias.name}"
        from_targets.append((node.module, names))

def chain_of(node):
    parts = []
    cur = node
    while isinstance(cur, ast.Attribute):
        parts.append(cur.attr)
        cur = cur.value
    if isinstance(cur, ast.Name):
        parts.append(cur.id)
        return list(reversed(parts))
    return None

chains = []
for node in ast.walk(tree):
    if isinstance(node, ast.Attribute):
        c = chain_of(node)
        if c and len(c) >= 2 and c[0] in imports:
            chains.append(tuple(c))
chains = sorted(set(chains), key=lambda t: (-len(t), t))

unresolved = set()
checked = 0
mod_cache = {}

def get_module(name):
    if name not in mod_cache:
        try:
            mod_cache[name] = importlib.import_module(name)
        except Exception as e:
            mod_cache[name] = e
    return mod_cache[name]

for chain in chains:
    base_local = chain[0]
    base_path = imports.get(base_local)
    if not base_path:
        continue
    base = get_module(base_path.split(".")[0])
    if isinstance(base, Exception):
        unresolved.add(".".join(chain))
        checked += 1
        continue
    obj = base
    ok = True
    for part in base_path.split(".")[1:]:
        try:
            obj = getattr(obj, part)
        except AttributeError:
            ok = False
            break
    if not ok:
        unresolved.add(".".join(chain))
        checked += 1
        continue
    for attr in chain[1:]:
        try:
            obj = getattr(obj, attr)
        except AttributeError:
            ok = False
            break
        except Exception:
            break
    if not ok:
        unresolved.add(".".join(chain))
    checked += 1

for module, names in from_targets:
    base = get_module(module)
    if isinstance(base, Exception):
        for _local, real in names:
            if real != "*":
                unresolved.add(f"{module}.{real}")
                checked += 1
        continue
    for _local, real in names:
        if real == "*":
            continue
        checked += 1
        if not hasattr(base, real):
            unresolved.add(f"{module}.{real}")

print(json.dumps({
    "syntax_error": None,
    "unresolved": sorted(unresolved),
    "checked": checked,
}))
`;

export async function scoreAstHallucination(
  sample: Sample,
  sandbox: Sandbox
): Promise<AstHallucinationScore> {
  const started = Date.now();
  if (!(await sandbox.workFileExists("solution.py"))) {
    return {
      hallucinated: false,
      unresolvedSymbols: [],
      totalSymbolsChecked: 0,
      syntaxError: "no /work/solution.py produced by solver",
      durationMs: Date.now() - started,
    };
  }
  await sandbox.writeContainerFile("/eval/ast_check.py", AST_CHECK);
  const r = await sandbox.exec("python /eval/ast_check.py", { timeoutSec: 60 });

  if (r.exitCode !== 0) {
    return {
      hallucinated: false,
      unresolvedSymbols: [],
      totalSymbolsChecked: 0,
      syntaxError: `scorer failed: exit ${r.exitCode}; stderr: ${r.stderr.slice(0, 500)}`,
      durationMs: Date.now() - started,
    };
  }

  try {
    const parsed = JSON.parse(r.stdout.trim()) as {
      syntax_error: string | null;
      unresolved: string[];
      checked: number;
    };
    return {
      hallucinated: parsed.unresolved.length > 0,
      unresolvedSymbols: parsed.unresolved,
      totalSymbolsChecked: parsed.checked,
      syntaxError: parsed.syntax_error,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      hallucinated: false,
      unresolvedSymbols: [],
      totalSymbolsChecked: 0,
      syntaxError: `scorer JSON parse failed: ${(err as Error).message}`,
      durationMs: Date.now() - started,
    };
  }
}
