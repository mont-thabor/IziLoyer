import { addDays, addMonths, dueDate, firstOfMonth, isValidDate } from './lease-dates';

describe('lease-dates (calculs purs)', () => {
  it('date valide / invalide', () => {
    expect(isValidDate('2026-10-09')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('09/10/2026')).toBe(false);
    expect(isValidDate('')).toBe(false);
  });

  it('premier du mois, ajout de jours et de mois sans debordement', () => {
    expect(firstOfMonth('2026-10-23')).toBe('2026-10-01');
    expect(addDays('2026-10-30', 5)).toBe('2026-11-04');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-01');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-01');
  });

  it('echeance ordinaire : le jour limite du mois', () => {
    expect(dueDate('2026-11-01', 5)).toBe('2026-11-05');
    expect(dueDate('2026-11-01', 28)).toBe('2026-11-28');
  });

  it('premiere echeance : max(jour limite, prise d effet + 5 jours) (D10)', () => {
    expect(dueDate('2026-10-01', 5, '2026-10-01')).toBe('2026-10-06');
    expect(dueDate('2026-10-01', 5, '2026-10-20')).toBe('2026-10-25');
    expect(dueDate('2026-10-01', 28, '2026-10-10')).toBe('2026-10-28');
    expect(dueDate('2026-10-01', 5, '2026-10-30')).toBe('2026-11-04');
  });
});
