// Tests d'integration : vraie base Docker, donnees de test nettoyees a la fin.
import { HttpException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { SmsProvider } from '../auth/sms/sms.provider';
import { DatabaseModule } from '../database/database.module';
import { DatabaseService } from '../database/database.service';
import { Fixtures } from '../testing/fixtures';
import { addDays, addMonths, dueDate, firstOfMonth, todayAbidjan } from './lease-dates';
import { CreateLeaseDto } from './leases.dto';
import { LeasesService } from './leases.service';

class FakeSms extends SmsProvider {
  last = '';
  async send(_to: string, message: string): Promise<void> {
    this.last = message;
  }
}

describe('LeasesService (integration, base reelle)', () => {
  let mod: TestingModule;
  let svc: LeasesService;
  let db: DatabaseService;
  let fx: Fixtures;
  const sms = new FakeSms();
  const today = todayAbidjan();
  const m0 = firstOfMonth(today);

  const asOwner = (id: number) => ({ id, role: 'PROPRIETAIRE' });
  const dto = (localId: number, extra: Partial<CreateLeaseDto> = {}): CreateLeaseDto =>
    ({
      local_id: localId,
      locataire_telephone: fx.phone(),
      locataire_nom: 'Locataire',
      locataire_prenoms: 'Test',
      date_prise_effet: m0,
      ...extra,
    }) as CreateLeaseDto;
  const statusOf = async (p: Promise<unknown>): Promise<number> => {
    try {
      await p;
      return 200;
    } catch (e) {
      return (e as HttpException).getStatus();
    }
  };
  const installments = async (leaseId: number) =>
    (
      await db.query(
        `SELECT id, type, mois, libelle, montant_du, montant_percu, statut_paiement, est_en_retard, date_echeance, saisi_par
           FROM izl_t_installment WHERE lease_id = $1 ORDER BY (type = 'LOYER'), COALESCE(mois, date_echeance), id`,
        [leaseId],
      )
    ).rows;
  const receipts = async (leaseId: number) =>
    (await db.query('SELECT type, numero_sequence FROM izl_t_receipt WHERE lease_id = $1 ORDER BY numero_sequence', [leaseId])).rows;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
      providers: [LeasesService, { provide: SmsProvider, useValue: sms }],
    }).compile();
    svc = mod.get(LeasesService);
    db = mod.get(DatabaseService);
    fx = new Fixtures(db);
  });

  afterAll(async () => {
    await fx.cleanup();
    await mod.close();
  });

  it('critere 12 : premiere echeance immediate ; generation rejouee sans doublon', async () => {
    const o = await fx.mkOwner();
    const local = await fx.mkLocal(o.id);
    const lease = await svc.create(asOwner(o.id), dto(local));

    const rows = await installments(lease.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'LOYER',
      mois: m0,
      montant_du: 100000,
      statut_paiement: 'EN_ATTENTE',
      date_echeance: dueDate(m0, 5, m0),
    });

    await svc.generateInstallments(undefined, lease.id);
    await svc.generateInstallments(undefined, lease.id);
    expect(await installments(lease.id)).toHaveLength(1);

    expect(sms.last).toContain('IziLoyer');
    const log = await db.query('SELECT statut FROM izl_t_sms_log WHERE cle_idempotence = $1', [`INVITATION-BAIL-${lease.id}`]);
    expect(log.rows[0].statut).toBe('ENVOYE');
  });

  it('critere 24 : avance d ouverture appliquee a la premiere echeance, une quittance d avance + une d acompte', async () => {
    const o = await fx.mkOwner();
    const lease = await svc.create(asOwner(o.id), dto(await fx.mkLocal(o.id), { avance: 60000 }));

    const inst = (await installments(lease.id))[0];
    expect(inst).toMatchObject({ montant_percu: 60000, statut_paiement: 'PARTIEL' });
    const pay = await db.query(`SELECT voie, montant, excedent_initial, excedent_restant FROM izl_t_payment WHERE lease_id = $1`, [lease.id]);
    expect(pay.rows[0]).toMatchObject({ voie: 'OUVERTURE', montant: 60000, excedent_initial: 60000, excedent_restant: 0 });
    expect(await receipts(lease.id)).toEqual([
      { type: 'AVANCE', numero_sequence: 1 },
      { type: 'ACOMPTE', numero_sequence: 2 },
    ]);
  });

  it('avance superieure au loyer : echeance soldee, reliquat en credit, applique a l echeance suivante (critere 18)', async () => {
    const o = await fx.mkOwner();
    const lease = await svc.create(asOwner(o.id), dto(await fx.mkLocal(o.id), { avance: 150000 }));

    expect((await installments(lease.id))[0]).toMatchObject({ statut_paiement: 'PAYE', montant_percu: 100000 });
    expect((await svc.get(asOwner(o.id), lease.id)).credit_disponible).toBe(50000);
    expect((await receipts(lease.id)).map((r) => r.type)).toEqual(['AVANCE', 'SOLDE']);

    // le mois suivant : generation -> le credit de 50 000 est consomme
    const next = addMonths(m0, 1);
    const gen = await svc.generateInstallments(next, lease.id);
    expect(gen.creees).toBe(1);
    const rows = await installments(lease.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ mois: next, montant_percu: 50000, statut_paiement: 'PARTIEL' });
    expect((await svc.get(asOwner(o.id), lease.id)).credit_disponible).toBe(0);
    const alloc = await db.query(
      `SELECT a.source, a.montant FROM izl_t_payment_allocation a WHERE a.installment_id = $1`,
      [rows[1].id],
    );
    expect(alloc.rows).toEqual([{ source: 'CREDIT', montant: 50000 }]);
    expect((await receipts(lease.id)).map((r) => r.type)).toEqual(['AVANCE', 'SOLDE', 'ACOMPTE']);

    // rejeu : aucun doublon, aucun credit en plus
    expect((await svc.generateInstallments(next, lease.id)).creees).toBe(0);
    expect(await installments(lease.id)).toHaveLength(2);
  });

  it('critere 22 : creances de reprise, saisies par le bailleur, reglees en premier, en retard si la date est passee', async () => {
    const o = await fx.mkOwner();
    const lease = await svc.create(
      asOwner(o.id),
      dto(await fx.mkLocal(o.id), {
        arrieres: [
          { libelle: 'Arrieres 2026', montant: 30000, date_limite: addDays(today, 20) },
          { libelle: 'Arrieres 2025', montant: 50000, date_limite: addDays(today, -10) },
        ],
      }),
    );
    const d = await svc.debt(asOwner(o.id), lease.id);
    expect(d.dette).toMatchObject({ totale: 180000, a_un_retard: true });
    // ordre FIFO : reprises par date limite croissante, puis loyer
    expect(d.echeances.map((e: any) => e.type)).toEqual(['REPRISE', 'REPRISE', 'LOYER']);
    expect(d.echeances[0]).toMatchObject({ libelle: 'Arrieres 2025', est_en_retard: true });
    expect(d.echeances[1]).toMatchObject({ libelle: 'Arrieres 2026', est_en_retard: false });
    const rows = await installments(lease.id);
    expect(rows.filter((r: any) => r.type === 'REPRISE').every((r: any) => r.saisi_par === o.id)).toBe(true);
  });

  it('critere 25 : caution = un recu, hors dette et hors credit', async () => {
    const o = await fx.mkOwner();
    const lease = await svc.create(
      asOwner(o.id),
      dto(await fx.mkLocal(o.id), { caution: { montant: 100000, date_reception: today, mode: 'especes' } }),
    );
    const l = await svc.get(asOwner(o.id), lease.id);
    expect(l.caution).toMatchObject({ montant: 100000, statut: 'DETENUE' });
    expect(l.dette.totale).toBe(100000);           // le loyer seulement
    expect(l.credit_disponible).toBe(0);
    expect(await receipts(lease.id)).toEqual([{ type: 'CAUTION', numero_sequence: 1 }]);
  });

  it('refus : sans compte Wave actif (critere 39), prise d effet trop ancienne, local d un autre, locataire = bailleur', async () => {
    const sansWave = await fx.mkOwner({ wave: false });
    expect(await statusOf(svc.create(asOwner(sansWave.id), dto(await fx.mkLocal(sansWave.id))))).toBe(422);

    const o = await fx.mkOwner();
    const local = await fx.mkLocal(o.id);
    expect(await statusOf(svc.create(asOwner(o.id), dto(local, { date_prise_effet: addDays(m0, -1) })))).toBe(400);
    expect(await statusOf(svc.create(asOwner(o.id), dto(local, { jour_limite: 3 })))).toBe(400);
    expect(await statusOf(svc.create(asOwner(o.id), dto(local, { locataire_telephone: o.tel })))).toBe(409);

    const autre = await fx.mkOwner();
    expect(await statusOf(svc.create(asOwner(autre.id), dto(local)))).toBe(404);
  });

  it('critere 14 : un seul bail actif par local (409)', async () => {
    const o = await fx.mkOwner();
    const local = await fx.mkLocal(o.id);
    await svc.create(asOwner(o.id), dto(local));
    expect(await statusOf(svc.create(asOwner(o.id), dto(local)))).toBe(409);
  });

  it('critere 27 : essai limite a 3 baux actifs ; une place se libere apres cloture', async () => {
    const o = await fx.mkOwner({ essai: true });
    const leases: any[] = [];
    for (let i = 0; i < 3; i++) leases.push(await svc.create(asOwner(o.id), dto(await fx.mkLocal(o.id))));
    const quatrieme = await fx.mkLocal(o.id);
    expect(await statusOf(svc.create(asOwner(o.id), dto(quatrieme)))).toBe(422);

    await svc.terminate(asOwner(o.id), leases[0].id, { date_fin: today });
    expect(await statusOf(svc.create(asOwner(o.id), dto(quatrieme)))).toBe(200);
  });

  it('critere 13 : cloture -> plus d echeance, dette residuelle visible, local libre ; autre bailleur : 404', async () => {
    const o = await fx.mkOwner();
    const local = await fx.mkLocal(o.id);
    const lease = await svc.create(asOwner(o.id), dto(local));

    const autre = await fx.mkOwner();
    expect(await statusOf(svc.terminate(asOwner(autre.id), lease.id, { date_fin: today }))).toBe(404);

    const r = await svc.terminate(asOwner(o.id), lease.id, { date_fin: today, type: 'RESILIE' });
    expect(r.statut).toBe('RESILIE');
    expect(await statusOf(svc.terminate(asOwner(o.id), lease.id, { date_fin: today }))).toBe(409); // deja clos

    // aucune echeance apres la cloture
    expect((await svc.generateInstallments(addMonths(m0, 2), lease.id)).creees).toBe(0);
    expect(await installments(lease.id)).toHaveLength(1);
    // dette residuelle toujours exigible et visible
    expect((await svc.debt(asOwner(o.id), lease.id)).dette.totale).toBe(100000);
    // le local est libre : un nouveau bail est possible
    expect(await statusOf(svc.create(asOwner(o.id), dto(local)))).toBe(200);
  });

  it('cloture impossible tant qu un paiement est en cours (SFD-03)', async () => {
    const o = await fx.mkOwner();
    const lease = await svc.create(asOwner(o.id), dto(await fx.mkLocal(o.id)));
    const ref = `T-${Math.floor(Math.random() * 1e9)}`;
    await db.query(
      `INSERT INTO izl_t_checkout_session (lease_id, client_reference, montant, expires_at)
       VALUES ($1, $2, 5000, now() + interval '30 minutes')`,
      [lease.id, ref],
    );
    expect(await statusOf(svc.terminate(asOwner(o.id), lease.id, { date_fin: today }))).toBe(409);
    await db.query(`UPDATE izl_t_checkout_session SET statut = 'EXPIREE' WHERE client_reference = $1`, [ref]);
    expect(await statusOf(svc.terminate(asOwner(o.id), lease.id, { date_fin: today }))).toBe(200);
  });

  it('acces : le locataire voit son bail, un tiers non (404)', async () => {
    const o = await fx.mkOwner();
    const lease = await svc.create(asOwner(o.id), dto(await fx.mkLocal(o.id)));
    const tenantId = lease.locataire_id;

    expect((await svc.get({ id: tenantId, role: 'LOCATAIRE' }, lease.id)).id).toBe(lease.id);
    expect((await svc.list({ id: tenantId, role: 'LOCATAIRE' })).map((l: any) => l.id)).toContain(lease.id);

    const tiers = await fx.mkOwner();
    expect(await statusOf(svc.get(asOwner(tiers.id), lease.id))).toBe(404);
  });
});
