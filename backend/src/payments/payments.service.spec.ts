// Tests d'integration : vraie base Docker, donnees de test nettoyees a la fin.
import { HttpException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { SmsProvider } from '../auth/sms/sms.provider';
import { DatabaseModule } from '../database/database.module';
import { DatabaseService } from '../database/database.service';
import { addDays, addMonths, firstOfMonth, todayAbidjan } from '../leases/lease-dates';
import { CreateLeaseDto } from '../leases/leases.dto';
import { LeasesService } from '../leases/leases.service';
import { Fixtures } from '../testing/fixtures';
import { PaymentsService } from './payments.service';

class FakeSms extends SmsProvider {
  sent: { to: string; message: string }[] = [];
  async send(to: string, message: string): Promise<void> {
    this.sent.push({ to, message });
  }
}

describe('PaymentsService (integration, base reelle)', () => {
  let mod: TestingModule;
  let svc: PaymentsService;
  let leases: LeasesService;
  let db: DatabaseService;
  let fx: Fixtures;
  const sms = new FakeSms();
  const today = todayAbidjan();
  const m0 = firstOfMonth(today);
  const prefix = `T6-${Date.now()}`;
  let seq = 0;
  const nextTx = () => `${prefix}-${++seq}`;

  const statusOf = async (p: Promise<unknown>): Promise<number> => {
    try {
      await p;
      return 200;
    } catch (e) {
      return (e as HttpException).getStatus();
    }
  };

  // Un bail neuf (bailleur + local + locataire), loyer 100 000, prise d'effet ce mois-ci
  const newLease = async (extra: Partial<CreateLeaseDto> = {}) => {
    const owner = await fx.mkOwner();
    const local = await fx.mkLocal(owner.id);
    const lease = await leases.create(
      { id: owner.id, role: 'PROPRIETAIRE' },
      {
        local_id: local,
        locataire_telephone: fx.phone(),
        locataire_nom: 'Kouassi',
        locataire_prenoms: 'Awa',
        date_prise_effet: m0,
        ...extra,
      } as CreateLeaseDto,
    );
    return { owner, leaseId: lease.id as number, tenantTel: lease.locataire_telephone as string };
  };

  const payA = (leaseId: number, montant: number, tx = nextTx()) =>
    svc.processPayment({
      voie: 'A',
      leaseId,
      event: { transactionId: tx, eventType: 'checkout.session.completed', source: 'WEBHOOK', montant, payload: {} },
    });
  const payB = (leaseId: number, montant: number, tx = nextTx()) =>
    svc.processPayment({
      voie: 'B',
      leaseId,
      event: { transactionId: tx, eventType: 'transfer.verified', source: 'VERIF_VOIE_B', montant, payload: {} },
    });
  const cash = (leaseId: number, ownerId: number, montant: number, key: string, extra: Record<string, unknown> = {}) =>
    svc.processPayment({
      voie: 'C',
      leaseId,
      montant,
      dateRemise: today,
      saisiPar: ownerId,
      idempotencyKey: key,
      ...extra,
    } as any);

  const installments = async (leaseId: number) =>
    (
      await db.query(
        `SELECT id, type, mois, montant_du, montant_percu, statut_paiement
           FROM izl_t_installment WHERE lease_id = $1 ORDER BY (type = 'LOYER'), COALESCE(mois, date_echeance), id`,
        [leaseId],
      )
    ).rows;
  const receipts = async (leaseId: number) =>
    (
      await db.query(
        'SELECT type, numero_sequence, statut_generation FROM izl_t_receipt WHERE lease_id = $1 ORDER BY numero_sequence',
        [leaseId],
      )
    ).rows;
  const count = async (sql: string, params: unknown[]) => (await db.query<{ n: number }>(sql, params)).rows[0].n;
  const nbPayments = (leaseId: number) => count('SELECT count(*)::int AS n FROM izl_t_payment WHERE lease_id = $1', [leaseId]);

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
      providers: [PaymentsService, LeasesService, { provide: SmsProvider, useValue: sms }],
    }).compile();
    svc = mod.get(PaymentsService);
    leases = mod.get(LeasesService);
    db = mod.get(DatabaseService);
    fx = new Fixtures(db);
  });

  afterAll(async () => {
    await fx.cleanup();
    // les evenements Wave sont en append-only : nettoyage avec les triggers desactives (dev uniquement)
    await db.transaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM izl_t_wave_event WHERE transaction_id LIKE $1', [`${prefix}%`]);
    });
    await mod.close();
  });

  // ------------------------------------------------------------------ allocation FIFO
  it('critere 3 : paiement partiel puis solde -> PARTIEL puis PAYE, quittances ACOMPTE puis SOLDE', async () => {
    const { leaseId } = await newLease();
    const r1 = await payA(leaseId, 40000);
    expect(r1).toMatchObject({ status: 'CREATED', surplus: 0, detteRestante: 60000 });
    expect((await installments(leaseId))[0]).toMatchObject({ montant_percu: 40000, statut_paiement: 'PARTIEL' });

    const r2 = await payA(leaseId, 60000);
    expect(r2.detteRestante).toBe(0);
    expect((await installments(leaseId))[0]).toMatchObject({ montant_percu: 100000, statut_paiement: 'PAYE' });
    expect(await receipts(leaseId)).toEqual([
      { type: 'ACOMPTE', numero_sequence: 1, statut_generation: 'A_GENERER' },
      { type: 'SOLDE', numero_sequence: 2, statut_generation: 'A_GENERER' },
    ]);
  });

  it('critere 4 : un paiement couvrant deux mois solde le plus ancien d abord, une quittance par mois', async () => {
    const { leaseId } = await newLease();
    await leases.generateInstallments(addMonths(m0, 1), leaseId); // mois courant + mois suivant
    const r = await payA(leaseId, 150000);
    const rows = await installments(leaseId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ mois: m0, statut_paiement: 'PAYE', montant_percu: 100000 });
    expect(rows[1]).toMatchObject({ statut_paiement: 'PARTIEL', montant_percu: 50000 });
    expect(r.allocations.map((a) => a.recu)).toEqual(['SOLDE', 'ACOMPTE']);
    expect((await receipts(leaseId)).map((x) => x.numero_sequence)).toEqual([1, 2]);
  });

  it('creances de reprise reglees en premier (FIFO)', async () => {
    const { leaseId } = await newLease({
      arrieres: [{ libelle: 'Arrieres', montant: 50000, date_limite: addDays(today, -5) }],
    });
    const r = await payA(leaseId, 70000);
    const rows = await installments(leaseId);
    expect(rows[0]).toMatchObject({ type: 'REPRISE', statut_paiement: 'PAYE' });
    expect(rows[1]).toMatchObject({ type: 'LOYER', montant_percu: 20000, statut_paiement: 'PARTIEL' });
    expect(r.allocations.map((a) => a.recu)).toEqual(['SOLDE', 'ACOMPTE']);
  });

  // ------------------------------------------------------------------ surplus et credit
  it('criteres 5 et 18 : surplus -> credit, une seule quittance d avance (meme en rejeu), credit applique au mois suivant', async () => {
    const { leaseId, tenantTel } = await newLease();
    const tx = nextTx();
    const r = await payB(leaseId, 130000, tx);
    expect(r).toMatchObject({ status: 'CREATED', surplus: 30000, detteRestante: 0 });

    const pay = await db.query('SELECT voie, excedent_initial, excedent_restant FROM izl_t_payment WHERE id = $1', [r.paymentId]);
    expect(pay.rows[0]).toEqual({ voie: 'B', excedent_initial: 30000, excedent_restant: 30000 });
    expect((await receipts(leaseId)).map((x) => x.type)).toEqual(['SOLDE', 'AVANCE']);
    // SMS d'avoir fusionne avec la confirmation, avec l'equivalent en loyers
    const smsLoc = sms.sent.filter((s) => s.to === tenantTel).map((s) => s.message);
    expect(smsLoc.some((m) => m.includes('Votre avoir: 30000 F, soit moins d un loyer'))).toBe(true);

    // rejeu du meme evenement : aucun effet
    const again = await payB(leaseId, 130000, tx);
    expect(again).toMatchObject({ status: 'DUPLICATE', paymentId: r.paymentId });
    expect(await count(`SELECT count(*)::int AS n FROM izl_t_receipt WHERE lease_id = $1 AND type = 'AVANCE'`, [leaseId])).toBe(1);

    // le mois suivant, le credit est consomme
    await leases.generateInstallments(addMonths(m0, 1), leaseId);
    const rows = await installments(leaseId);
    expect(rows[1]).toMatchObject({ montant_percu: 30000, statut_paiement: 'PARTIEL' });
    const after = await db.query('SELECT excedent_restant FROM izl_t_payment WHERE id = $1', [r.paymentId]);
    expect(after.rows[0].excedent_restant).toBe(0);
  });

  it('critere 19 : un credit couvrant tout un loyer solde l echeance sans nouveau versement, hors "total percu"', async () => {
    const { owner, leaseId } = await newLease();
    await payB(leaseId, 250000);
    await leases.generateInstallments(addMonths(m0, 1), leaseId);

    const rows = await installments(leaseId);
    expect(rows[1]).toMatchObject({ statut_paiement: 'PAYE', montant_percu: 100000 });
    expect((await receipts(leaseId)).map((x) => x.type)).toEqual(['SOLDE', 'AVANCE', 'SOLDE']);
    expect(await nbPayments(leaseId)).toBe(1);

    const kpi = await db.query(
      `SELECT total_percu_mois::bigint AS tp, regle_par_credit_mois::bigint AS rc
         FROM izl_v_owner_month_kpis WHERE proprietaire_id = $1`,
      [owner.id],
    );
    expect(kpi.rows[0]).toEqual({ tp: 250000, rc: 100000 });
  });

  // ------------------------------------------------------------------ idempotence et concurrence
  it('critere 1 : evenement rejoue (en sequence ou simultane) -> un seul paiement', async () => {
    const { leaseId } = await newLease();
    const tx = nextTx();
    const a = await payA(leaseId, 30000, tx);
    const b = await payA(leaseId, 30000, tx);
    expect(a.status).toBe('CREATED');
    expect(b).toMatchObject({ status: 'DUPLICATE', paymentId: a.paymentId });

    const tx2 = nextTx();
    const both = await Promise.all([payA(leaseId, 20000, tx2), payA(leaseId, 20000, tx2)]);
    expect(both.map((r) => r.status).sort()).toEqual(['CREATED', 'DUPLICATE']);

    expect(await nbPayments(leaseId)).toBe(2);
    expect(await count('SELECT count(*)::int AS n FROM izl_t_wave_event WHERE transaction_id = $1', [tx2])).toBe(1);
    expect((await installments(leaseId))[0].montant_percu).toBe(50000);
    const nums = (await receipts(leaseId)).map((r) => r.numero_sequence);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it('critere 11 : trois paiements simultanes sur un meme bail -> montant exact, numeros de quittance distincts', async () => {
    const { leaseId } = await newLease();
    await Promise.all([30000, 30000, 30000].map((m) => payA(leaseId, m)));
    expect((await installments(leaseId))[0]).toMatchObject({ montant_percu: 90000, statut_paiement: 'PARTIEL' });
    expect((await receipts(leaseId)).map((r) => r.numero_sequence)).toEqual([1, 2, 3]);
    const sum = await count(
      `SELECT COALESCE(sum(a.montant), 0)::int AS n FROM izl_t_payment_allocation a
         JOIN izl_t_payment p ON p.id = a.payment_id WHERE p.lease_id = $1`,
      [leaseId],
    );
    expect(sum).toBe(90000);
  });

  // ------------------------------------------------------------------ mode degrade
  it('critere 30 : bailleur en mode degrade -> paiement accepte, quittances en attente d abonnement, SMS envoye', async () => {
    const { owner, leaseId, tenantTel } = await newLease();
    await db.query(
      `INSERT INTO izl_t_owner_subscription (owner_id, statut, essai_fin) VALUES ($1, 'DEGRADE', current_date - 30)`,
      [owner.id],
    );
    const r = await payA(leaseId, 100000);
    expect(r.status).toBe('CREATED');
    expect((await installments(leaseId))[0].statut_paiement).toBe('PAYE');
    expect((await receipts(leaseId)).every((x) => x.statut_generation === 'EN_ATTENTE_ABONNEMENT')).toBe(true);
    expect(sms.sent.some((s) => s.to === tenantTel && s.message.includes('paiement de 100000 F'))).toBe(true);
  });

  // ------------------------------------------------------------------ Voie C (especes)
  it('critere 35 : especes <= dette -> allocation FIFO, quittance, SMS "especes", trace d audit', async () => {
    const { owner, leaseId, tenantTel } = await newLease();
    const r = await cash(leaseId, owner.id, 50000, 'key-35-aaaa');
    expect(r).toMatchObject({ status: 'CREATED', surplus: 0, detteRestante: 50000 });
    expect((await installments(leaseId))[0]).toMatchObject({ montant_percu: 50000, statut_paiement: 'PARTIEL' });
    expect((await receipts(leaseId)).map((x) => x.type)).toEqual(['ACOMPTE']);
    const p = await db.query('SELECT voie, date_remise, saisi_par FROM izl_t_payment WHERE id = $1', [r.paymentId]);
    expect(p.rows[0]).toEqual({ voie: 'C', date_remise: today, saisi_par: owner.id });
    expect(sms.sent.some((s) => s.to === tenantTel && s.message.includes('en especes de 50000 F'))).toBe(true);
    expect(await count(`SELECT count(*)::int AS n FROM izl_t_audit_log WHERE lease_id = $1 AND evenement = 'PAIEMENT_ESPECES'`, [leaseId])).toBe(1);
  });

  it('critere 36 : depassement -> avertissement ; sans confirmation rien n est enregistre ; confirme -> avoir', async () => {
    const { owner, leaseId } = await newLease();
    const err: any = await cash(leaseId, owner.id, 150000, 'key-36-aaaa').catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: 'DEPASSEMENT', dette: 100000, excedent: 50000 });
    expect(await nbPayments(leaseId)).toBe(0);

    const r = await cash(leaseId, owner.id, 150000, 'key-36-aaaa', { confirmerDepassement: true });
    expect(r).toMatchObject({ status: 'CREATED', surplus: 50000 });
    expect((await receipts(leaseId)).map((x) => x.type)).toEqual(['SOLDE', 'AVANCE']);
  });

  it('critere 37 : dates de remise, double soumission, autre bailleur, doublon probable', async () => {
    const { owner, leaseId } = await newLease();
    expect(await statusOf(cash(leaseId, owner.id, 10000, 'key-37-fut1', { dateRemise: addDays(today, 1) }))).toBe(400);
    expect(await statusOf(cash(leaseId, owner.id, 10000, 'key-37-old1', { dateRemise: addDays(m0, -1) }))).toBe(400);
    expect(await statusOf(cash(leaseId, owner.id, 0, 'key-37-zero'))).toBe(400);

    const autre = await fx.mkOwner();
    expect(await statusOf(cash(leaseId, autre.id, 10000, 'key-37-autr'))).toBe(404);

    const a = await cash(leaseId, owner.id, 10000, 'key-37-aaaa');
    const b = await cash(leaseId, owner.id, 10000, 'key-37-aaaa');          // meme cle : double soumission
    expect(b).toMatchObject({ status: 'DUPLICATE', paymentId: a.paymentId });
    expect(await nbPayments(leaseId)).toBe(1);

    const err: any = await cash(leaseId, owner.id, 10000, 'key-37-bbbb').catch((e) => e); // meme montant < 10 min
    expect(err.getResponse()).toMatchObject({ code: 'DOUBLON_PROBABLE' });
    const c = await cash(leaseId, owner.id, 10000, 'key-37-bbbb', { confirmerDoublon: true });
    expect(c.status).toBe('CREATED');
    expect(await nbPayments(leaseId)).toBe(2);
  });

  it('bail inconnu -> 404, montant invalide -> 400', async () => {
    expect(await statusOf(payA(999999999, 10000))).toBe(404);
    expect(await statusOf(payA(1, 0))).toBe(400);
    expect(await statusOf(payA(1, 12.5))).toBe(400);
  });
});
