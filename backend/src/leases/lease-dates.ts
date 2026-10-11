// Calculs de dates en texte 'AAAA-MM-JJ', sans fuseau horaire (les dates SQL sont lues en texte).
// Africa/Abidjan = UTC+0 toute l'annee (pas d'heure d'ete) : "aujourd'hui" = date UTC.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s ?? '');
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const fmt = (dt: Date): string => dt.toISOString().slice(0, 10);
const parse = (s: string): Date => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

export function todayAbidjan(): string {
  return fmt(new Date());
}

export function firstOfMonth(s: string): string {
  return s.slice(0, 8) + '01';
}

export function addDays(s: string, n: number): string {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

// Part toujours du 1er du mois : pas de debordement (31 janvier + 1 mois ne devient jamais mars)
export function addMonths(s: string, n: number): string {
  const d = parse(firstOfMonth(s));
  d.setUTCMonth(d.getUTCMonth() + n);
  return fmt(d);
}

// Date d'echeance d'un loyer (SFD-04 4.1, D10).
//  - mois ordinaire : le jour limite du bail dans le mois
//  - premiere echeance (datePriseEffet fournie) : max(jour limite du mois, prise d'effet + 5 jours)
export function dueDate(mois: string, jourLimite: number, datePriseEffet?: string): string {
  const base = mois.slice(0, 8) + String(jourLimite).padStart(2, '0');
  if (!datePriseEffet) return base;
  const min = addDays(datePriseEffet, 5);
  return base > min ? base : min;
}
