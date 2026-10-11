// Normalise un numero saisi par l'utilisateur au format E.164 (+225...).
// Accepte : "+2250700000000", "0700000000" (numero ivoirien a 10 chiffres), "00225...", avec espaces ou tirets.
// Renvoie null si le numero est invalide.
export function normalizePhone(raw: string): string | null {
  let s = (raw ?? '').replace(/[\s.\-()]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^0\d{9}$/.test(s)) s = '+225' + s;
  return /^\+[0-9]{8,15}$/.test(s) ? s : null;
}
