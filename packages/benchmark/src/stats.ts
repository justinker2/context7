// Wilson score interval for a binomial proportion.
// Recommended over normal-approximation when N < 300 or p near 0/1.
export function wilson(successes: number, total: number, z = 1.96): { lo: number; hi: number; p: number } {
  if (total === 0) return { lo: 0, hi: 0, p: 0 };
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half), p };
}

// McNemar's exact / chi-square test on paired binary outcomes.
// b = baseline-pass-but-context7-fail; c = baseline-fail-but-context7-pass.
// Continuity-corrected chi-square; OK for b+c >= 25, falls back to exact binomial otherwise.
export function mcnemar(b: number, c: number): { stat: number; pValue: number; method: string } {
  const n = b + c;
  if (n === 0) return { stat: 0, pValue: 1, method: "no discordant pairs" };

  if (n < 25) {
    // Two-sided exact binomial against p=0.5
    const k = Math.min(b, c);
    let cum = 0;
    for (let i = 0; i <= k; i++) cum += binomPmf(i, n, 0.5);
    return { stat: k, pValue: Math.min(1, 2 * cum), method: "exact binomial" };
  }

  const stat = Math.pow(Math.abs(b - c) - 1, 2) / n;
  const pValue = chiSquareSurvival1(stat);
  return { stat, pValue, method: "chi-square (continuity corrected)" };
}

function binomPmf(k: number, n: number, p: number): number {
  return Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return logFact(n) - logFact(k) - logFact(n - k);
}

function logFact(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

// Survival function (1-CDF) of chi-square with 1 df.
// 1 - erf(sqrt(x/2)).
function chiSquareSurvival1(x: number): number {
  if (x <= 0) return 1;
  return 1 - erf(Math.sqrt(x / 2));
}

// Abramowitz & Stegun 7.1.26 polynomial approximation; |error| < 1.5e-7.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}
