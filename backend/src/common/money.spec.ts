import { equivalentLoyers, fmtFcfa, jourMois } from './money';

describe('money (mise en forme SMS)', () => {
  it('separateur de milliers', () => {
    expect(fmtFcfa(0)).toBe('0');
    expect(fmtFcfa(999)).toBe('999');
    expect(fmtFcfa(60000)).toBe('60 000');
    expect(fmtFcfa(1250000)).toBe('1 250 000');
  });

  it('equivalent d un avoir en loyers (SFD-04 4.10)', () => {
    expect(equivalentLoyers(60000, 60000)).toBe('1 loyer');
    expect(equivalentLoyers(120000, 60000)).toBe('2 loyers');
    expect(equivalentLoyers(90000, 60000)).toBe('1 loyer + 30 000 F');
    expect(equivalentLoyers(40000, 60000)).toBe("moins d'un loyer");
  });

  it('jour / mois', () => {
    expect(jourMois('2026-10-11')).toBe('11/10');
  });
});
