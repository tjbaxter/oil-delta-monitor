const EPSILON_T = 1e-6;
const EPSILON_S = 1e-6;

export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const value = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * value);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
      Math.exp(-value * value);

  return 0.5 * (1 + sign * erf);
}

export function bsCallPrice(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number
): number {
  if (S <= 0 || K <= 0) {
    throw new Error("S and K must be positive.");
  }

  if (T <= EPSILON_T || sigma <= 0) {
    return Math.max(S - K, 0);
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
}

export function tightCallSpreadFairProb(
  S: number,
  strike: number,
  width: number,
  T: number,
  r: number,
  sigma: number
): number {
  if (width <= 0) {
    throw new Error("Spread width must be positive.");
  }

  const k1 = strike - width / 2;
  const k2 = strike + width / 2;
  const c1 = bsCallPrice(S, k1, Math.max(T, EPSILON_T), r, sigma);
  const c2 = bsCallPrice(S, k2, Math.max(T, EPSILON_T), r, sigma);
  const fairProb = (c1 - c2) / width;

  return Math.max(0, Math.min(1, fairProb));
}

export function callSpreadDelta(
  S: number,
  strike: number,
  width: number,
  T: number,
  r: number,
  sigma: number,
  h = 0.01
): number {
  if (h <= 0) {
    throw new Error("h must be positive.");
  }

  const sUp = Math.max(S + h, EPSILON_S);
  const sDn = Math.max(S - h, EPSILON_S);
  const pUp = tightCallSpreadFairProb(sUp, strike, width, T, r, sigma);
  const pDn = tightCallSpreadFairProb(sDn, strike, width, T, r, sigma);

  return (pUp - pDn) / (sUp - sDn);
}

export function yearFractionToExpiry(
  expiry: string | Date | null | undefined,
  now: Date = new Date()
): number {
  if (!expiry) {
    return EPSILON_T;
  }

  const expiryDate = expiry instanceof Date ? expiry : new Date(expiry);
  if (Number.isNaN(expiryDate.getTime())) {
    return EPSILON_T;
  }

  const diffMs = expiryDate.getTime() - now.getTime();
  const yearFraction = diffMs / (365 * 24 * 60 * 60 * 1000);
  return Math.max(yearFraction, EPSILON_T);
}
