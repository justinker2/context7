const FENCED_PY = /```(?:python|py)\s*\n([\s\S]*?)```/gi;
const FENCED_ANY = /```\s*\n([\s\S]*?)```/g;

export function extractPython(text: string): string {
  const candidates: string[] = [];
  for (const m of text.matchAll(FENCED_PY)) {
    if (m[1]) candidates.push(m[1]);
  }
  if (candidates.length === 0) {
    for (const m of text.matchAll(FENCED_ANY)) {
      if (m[1]) candidates.push(m[1]);
    }
  }
  if (candidates.length === 0) return text.trim();
  return candidates.reduce((a, b) => (a.length >= b.length ? a : b)).trim();
}
