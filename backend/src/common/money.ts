// Mise en forme des montants pour les SMS (texte sans accents, un seul SMS)

// 120000 -> "120 000"
export function fmtFcfa(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// Equivalent d'un avoir en loyers (SFD-04 4.10) : N loyer(s) entier(s) + reste ; "moins d'un loyer" si N = 0
export function equivalentLoyers(avoir: number, loyer: number): string {
  const n = Math.floor(avoir / loyer);
  const reste = avoir - n * loyer;
  if (n === 0) return "moins d'un loyer";
  const base = `${n} loyer${n > 1 ? 's' : ''}`;
  return reste > 0 ? `${base} + ${fmtFcfa(reste)} F` : base;
}

// '2026-10-11' -> '11/10'
export function jourMois(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}
