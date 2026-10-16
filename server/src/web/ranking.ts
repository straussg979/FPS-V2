// Glicko-2 ratings for ranked duels (Mark Glickman, "Example of the Glicko-2 system", 2012): a rating r with a
// deviation RD (how uncertain it is) and a volatility sigma (how erratic the player's results are). Every
// ranked duel is its own rating period with one game. New players start at 1500 / 350 / 0.06.

export type Glicko = [number, number, number];

export const SCALE = 173.7178;
export const TAU = 0.5;                 // how much the volatility may change per period
export const START: Glicko = [1500.0, 350.0, 0.06];
export const MIN_RD = 30.0, MAX_RD = 350.0;
const EPS = 1e-6;

const g = (phi: number) => 1.0 / Math.sqrt(1.0 + 3.0 * phi * phi / (Math.PI * Math.PI));
const e = (mu: number, muJ: number, phiJ: number) => 1.0 / (1.0 + Math.exp(-g(phiJ) * (mu - muJ)));

/** Step 5: the new volatility by the Illinois algorithm. */
function volatility(phi: number, sigma: number, delta: number, v: number, tau: number): number {
  const a = Math.log(sigma * sigma);
  const f = (x: number) => {
    const ex = Math.exp(x);
    return ex * (delta * delta - phi * phi - v - ex) / (2.0 * (phi * phi + v + ex) ** 2) - (x - a) / (tau * tau);
  };
  let A = a, B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fa = f(A), fb = f(B);
  for (let i = 0; i < 100; i++) {
    if (Math.abs(B - A) <= EPS) break;
    const C = A + (A - B) * fa / (fb - fa);
    const fc = f(C);
    if (fc * fb <= 0) { A = B; fa = fb; } else fa /= 2.0;
    B = C;
    fb = fc;
  }
  return Math.exp(A / 2.0);
}

/** A rating period without games: only the deviation grows. */
export function decay([r, rd, sigma]: Glicko): Glicko {
  const phi = rd / SCALE;
  return [r, Math.min(Math.sqrt(phi * phi + sigma * sigma) * SCALE, MAX_RD), sigma];
}

/** (rating, RD, volatility) after one rating period with results [(opp rating, opp RD, score)]. */
export function update(player: Glicko, results: Array<[number, number, number]>, tau = TAU): Glicko {
  const [r, rd, sigma] = player;
  if (!results.length) return decay(player);
  const mu = (r - 1500.0) / SCALE, phi = rd / SCALE;
  let vInv = 0, deltaSum = 0;
  for (const [rJ, rdJ, s] of results) {
    const muJ = (rJ - 1500.0) / SCALE, phiJ = rdJ / SCALE;
    const gg = g(phiJ), ee = e(mu, muJ, phiJ);
    vInv += gg * gg * ee * (1.0 - ee);
    deltaSum += gg * (s - ee);
  }
  const v = 1.0 / vInv;
  const delta = v * deltaSum;
  const sigma2 = volatility(phi, sigma, delta, v, tau);
  const phiStar = Math.sqrt(phi * phi + sigma2 * sigma2);
  const phi2 = 1.0 / Math.sqrt(1.0 / (phiStar * phiStar) + 1.0 / v);
  const mu2 = mu + phi2 * phi2 * deltaSum;
  return [1500.0 + mu2 * SCALE, Math.min(Math.max(phi2 * SCALE, MIN_RD), MAX_RD), sigma2];
}

/** Both players' new ratings after one duel (scoreA: 1 a won, 0.5 a draw, 0 b won). */
export function duel(a: Glicko, b: Glicko, scoreA: number): [Glicko, Glicko] {
  return [update(a, [[b[0], b[1], scoreA]]), update(b, [[a[0], a[1], 1.0 - scoreA]])];
}

/** The chance that a beats b. */
export function expected(a: Glicko, b: Glicko): number {
  const mu = (a[0] - 1500.0) / SCALE, muJ = (b[0] - 1500.0) / SCALE;
  const phi = Math.sqrt((a[1] / SCALE) ** 2 + (b[1] / SCALE) ** 2);
  return e(mu, muJ, phi);
}
