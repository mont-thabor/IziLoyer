import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { normalizePhone } from '../auth/phone.util';
import { SmsProvider } from '../auth/sms/sms.provider';
import { AuthUser } from '../common/auth-user';
import { translateDbError } from '../common/db-errors';
import { DatabaseService } from '../database/database.service';
import { addMonths, dueDate, firstOfMonth, isValidDate, todayAbidjan } from './lease-dates';
import { CreateLeaseDto, TerminateLeaseDto } from './leases.dto';

interface LeaseRow {
  id: number;
  loyer_mensuel: number;
  jour_limite: number;
  date_prise_effet: string;
  date_fin: string | null;
}

@Injectable()
export class LeasesService {
  private readonly logger = new Logger(LeasesService.name);

  constructor(private readonly db: DatabaseService, private readonly sms: SmsProvider) {}

  // ================================================================== creation
  async create(owner: AuthUser, dto: CreateLeaseDto) {
    const today = todayAbidjan();

    const tel = normalizePhone(dto.locataire_telephone);
    if (!tel) throw new BadRequestException('Telephone du locataire invalide');
    const wave = dto.numero_wave ? normalizePhone(dto.numero_wave) : tel;
    if (!wave) throw new BadRequestException('Numero Wave du locataire invalide');

    this.requireDate(dto.date_prise_effet, 'date_prise_effet');
    // D10 : pas de bail retroactif au-dela du 1er du mois en cours
    if (dto.date_prise_effet < firstOfMonth(today)) {
      throw new BadRequestException('La prise d effet ne peut pas preceder le 1er du mois en cours');
    }
    if (dto.date_debut_contrat) {
      this.requireDate(dto.date_debut_contrat, 'date_debut_contrat');
      if (dto.date_debut_contrat > dto.date_prise_effet) {
        throw new BadRequestException('Le debut du contrat ne peut pas suivre la prise d effet');
      }
    }
    if (dto.date_fin) {
      this.requireDate(dto.date_fin, 'date_fin');
      if (dto.date_fin < dto.date_prise_effet) throw new BadRequestException('La date de fin precede la prise d effet');
    }
    for (const a of dto.arrieres ?? []) this.requireDate(a.date_limite, 'date_limite');
    if (dto.caution) {
      this.requireDate(dto.caution.date_reception, 'date_reception');
      if (dto.caution.date_reception > today) throw new BadRequestException('Date de reception de la caution dans le futur');
    }
    const jour = dto.jour_limite ?? 5;
    if (jour < 4 || jour > 28) throw new BadRequestException('Le jour limite doit etre compris entre 4 et 28');

    let leaseId: number;
    let loyer = 0;
    try {
      const out = await this.db.transaction(async (c) => {
        // --- local appartenant au bailleur (sinon "introuvable")
        const lo = await c.query<{ loyer_mensuel: number }>(
          `SELECT lo.loyer_mensuel
             FROM izl_t_local lo JOIN izl_t_site st ON st.id = lo.site_id
            WHERE lo.id = $1 AND st.proprietaire_id = $2`,
          [dto.local_id, owner.id],
        );
        if (lo.rows.length === 0) throw new NotFoundException('Local introuvable');
        const loyerBail = dto.loyer_mensuel ?? lo.rows[0].loyer_mensuel;

        // --- locataire : retrouve par telephone, sinon cree
        const tenantId = await this.findOrCreateTenant(c, tel, dto.locataire_nom, dto.locataire_prenoms);

        // --- bail (les triggers refusent : compte Wave non actif (D23), 4e bail pendant l'essai (D16))
        const l = await c.query<{ id: number }>(
          `INSERT INTO izl_t_lease
             (local_id, locataire_id, numero_wave, loyer_mensuel, jour_limite,
              date_debut_contrat, date_prise_effet, date_fin)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [dto.local_id, tenantId, wave, loyerBail, jour, dto.date_debut_contrat ?? null, dto.date_prise_effet, dto.date_fin ?? null],
        );
        const id = l.rows[0].id;

        // --- avance d'ouverture : credit AVANT la premiere echeance (SFD-04 4.1)
        if (dto.avance) {
          const p = await c.query<{ id: number }>(
            `INSERT INTO izl_t_payment (lease_id, voie, montant, excedent_initial, excedent_restant, saisi_par)
             VALUES ($1, 'OUVERTURE', $2, $2, $2, $3) RETURNING id`,
            [id, dto.avance, owner.id],
          );
          await c.query(`INSERT INTO izl_t_receipt (lease_id, payment_id, type) VALUES ($1, $2, 'AVANCE')`, [id, p.rows[0].id]);
        }

        // --- creances de reprise (arrieres) : echeances de type REPRISE, reglees en premier
        for (const a of dto.arrieres ?? []) {
          await c.query(
            `INSERT INTO izl_t_installment (lease_id, type, libelle, montant_du, date_echeance, saisi_par, est_en_retard)
             VALUES ($1, 'REPRISE', $2, $3, $4, $5, $4::date < $6::date)`,
            [id, a.libelle, a.montant, a.date_limite, owner.id, today],
          );
        }

        // --- premiere echeance immediate ; le credit eventuel s'y applique dans la meme transaction
        const lease: LeaseRow = {
          id,
          loyer_mensuel: loyerBail,
          jour_limite: jour,
          date_prise_effet: dto.date_prise_effet,
          date_fin: dto.date_fin ?? null,
        };
        const instId = await this.createRentInstallment(c, lease, firstOfMonth(dto.date_prise_effet), today);
        if (instId) await this.applyCredits(c, id, instId, today);

        // --- caution : ni dette, ni FIFO, ni credit (SFD-03). Recu de caution.
        if (dto.caution) {
          const d = await c.query<{ id: number }>(
            `INSERT INTO izl_t_security_deposit (lease_id, montant, date_reception, mode, saisi_par)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [id, dto.caution.montant, dto.caution.date_reception, dto.caution.mode, owner.id],
          );
          await c.query(`INSERT INTO izl_t_receipt (lease_id, deposit_id, type) VALUES ($1, $2, 'CAUTION')`, [id, d.rows[0].id]);
        }

        // --- SMS d'invitation journalise (cle d'idempotence : un seul SMS par bail)
        await c.query(
          `INSERT INTO izl_t_sms_log (destinataire, type, cle_idempotence, statut, contenu)
           VALUES ($1, 'INVITATION_BAIL', $2, 'A_ENVOYER', $3)`,
          [tel, `INVITATION-BAIL-${id}`, this.invitationMessage(loyerBail, jour)],
        );

        await c.query(
          `INSERT INTO izl_t_audit_log (acteur_id, lease_id, evenement, details) VALUES ($1, $2, 'CREATION_BAIL', $3)`,
          [owner.id, id, JSON.stringify({ avance: dto.avance ?? 0, nb_arrieres: dto.arrieres?.length ?? 0, caution: dto.caution?.montant ?? 0 })],
        );
        return { id, loyerBail };
      });
      leaseId = out.id;
      loyer = out.loyerBail;
    } catch (e) {
      translateDbError(e);
    }

    await this.sendInvitation(leaseId, tel, loyer, jour);
    return this.get(owner, leaseId);
  }

  // ================================================================== echeances
  // Generation mensuelle IDEMPOTENTE et RATTRAPANTE (SFD-04 4.1) : cree toutes les echeances
  // manquantes depuis la prise d'effet jusqu'au mois courant. Rejouable sans doublon
  // (index unique partiel + ON CONFLICT DO NOTHING). Appelee par le cron du 1er du mois (etape 8).
  // `asOf` et `onlyLeaseId` servent aux tests.
  async generateInstallments(asOf?: string, onlyLeaseId?: number): Promise<{ creees: number }> {
    const today = asOf ?? todayAbidjan();
    const mCur = firstOfMonth(today);
    const ids = await this.db.query<{ id: number }>(
      `SELECT id FROM izl_t_lease WHERE statut = 'ACTIF' AND ($1::bigint IS NULL OR id = $1) ORDER BY id`,
      [onlyLeaseId ?? null],
    );
    let creees = 0;
    for (const { id } of ids.rows) {
      try {
        creees += await this.db.transaction(async (c) => {
          // verrou : serialise avec cloture et paiements pour ce bail
          const r = await c.query<LeaseRow>(
            `SELECT id, loyer_mensuel, jour_limite, date_prise_effet, date_fin
               FROM izl_t_lease WHERE id = $1 AND statut = 'ACTIF' FOR UPDATE`,
            [id],
          );
          const lease = r.rows[0];
          if (!lease) return 0;
          let n = 0;
          for (let m = firstOfMonth(lease.date_prise_effet); m <= mCur; m = addMonths(m, 1)) {
            if (lease.date_fin && m > lease.date_fin) break;   // aucune echeance apres la date de fin
            const instId = await this.createRentInstallment(c, lease, m, today);
            if (instId) {
              await this.applyCredits(c, lease.id, instId, today);
              n++;
            }
          }
          return n;
        });
      } catch (e) {
        // un bail en erreur ne bloque pas les autres
        this.logger.error(`Generation des echeances du bail ${id} : ${(e as Error).message}`);
      }
    }
    return { creees };
  }

  // Cree l'echeance LOYER d'un mois ; renvoie null si elle existe deja (idempotence).
  private async createRentInstallment(c: PoolClient, l: LeaseRow, mois: string, today: string): Promise<number | null> {
    const premiere = mois === firstOfMonth(l.date_prise_effet);
    const echeance = dueDate(mois, l.jour_limite, premiere ? l.date_prise_effet : undefined);
    const r = await c.query<{ id: number }>(
      `INSERT INTO izl_t_installment (lease_id, type, mois, montant_du, date_echeance, est_en_retard)
       VALUES ($1, 'LOYER', $2, $3, $4, $4::date < $5::date)
       ON CONFLICT (lease_id, mois) WHERE type = 'LOYER' DO NOTHING
       RETURNING id`,
      [l.id, mois, l.loyer_mensuel, echeance, today],
    );
    return r.rows[0]?.id ?? null;
  }

  // Applique les credits du bail (FIFO sur les credits : le plus ancien d'abord) a une nouvelle echeance.
  // Chaque application = une allocation de source CREDIT + une quittance (ACOMPTE ou SOLDE).
  private async applyCredits(c: PoolClient, leaseId: number, installmentId: number, today: string): Promise<void> {
    const inst = await c.query<{ montant_du: number; montant_percu: number }>(
      'SELECT montant_du, montant_percu FROM izl_t_installment WHERE id = $1 FOR UPDATE',
      [installmentId],
    );
    let reste = inst.rows[0].montant_du - inst.rows[0].montant_percu;
    if (reste <= 0) return;

    const credits = await c.query<{ id: number; excedent_restant: number }>(
      `SELECT id, excedent_restant FROM izl_t_payment
        WHERE lease_id = $1 AND excedent_restant > 0
        ORDER BY date_paiement, id FOR UPDATE`,
      [leaseId],
    );
    for (const credit of credits.rows) {
      if (reste <= 0) break;
      const take = Math.min(reste, credit.excedent_restant);
      const a = await c.query<{ id: number }>(
        `INSERT INTO izl_t_payment_allocation (payment_id, installment_id, montant, source)
         VALUES ($1, $2, $3, 'CREDIT') RETURNING id`,
        [credit.id, installmentId, take],
      );
      // incrementation (jamais d'affectation directe) + decrement du credit
      await c.query('UPDATE izl_t_installment SET montant_percu = montant_percu + $2 WHERE id = $1', [installmentId, take]);
      await c.query('UPDATE izl_t_payment SET excedent_restant = excedent_restant - $2 WHERE id = $1', [credit.id, take]);
      reste -= take;
      await c.query(
        `INSERT INTO izl_t_receipt (lease_id, installment_id, allocation_id, type) VALUES ($1, $2, $3, $4)`,
        [leaseId, installmentId, a.rows[0].id, reste === 0 ? 'SOLDE' : 'ACOMPTE'],
      );
    }
    await c.query(
      `UPDATE izl_t_installment SET est_en_retard = (date_echeance < $2::date AND statut_paiement <> 'PAYE') WHERE id = $1`,
      [installmentId, today],
    );
  }

  // ================================================================== lecture
  async list(user: AuthUser) {
    const asOwner = user.role === 'PROPRIETAIRE';
    const r = await this.db.query(
      `SELECT l.id, l.statut, l.loyer_mensuel, l.date_prise_effet, l.date_fin,
              lo.designation AS local, st.nom AS site,
              u.nom AS locataire_nom, u.prenoms AS locataire_prenoms,
              d.dette_totale::bigint AS dette_totale, d.a_un_retard
         FROM izl_t_lease l
         JOIN izl_t_local lo ON lo.id = l.local_id
         JOIN izl_t_site  st ON st.id = lo.site_id
         JOIN izl_t_user  u  ON u.id  = l.locataire_id
         JOIN izl_v_lease_debt d ON d.lease_id = l.id
        WHERE ${asOwner ? 'st.proprietaire_id' : 'l.locataire_id'} = $1
        ORDER BY l.created_at DESC`,
      [user.id],
    );
    return r.rows;
  }

  async get(user: AuthUser, id: number) {
    const row = await this.loadAccessible(user, id);
    const [dette, credit, caution] = await Promise.all([
      this.debtSummary(id),
      this.db.query<{ total: number }>(
        'SELECT COALESCE(sum(excedent_restant), 0)::bigint AS total FROM izl_t_payment WHERE lease_id = $1',
        [id],
      ),
      this.db.query(
        `SELECT id, montant, date_reception, mode, statut, montant_restitue, montant_retenu, motif_retenue, date_restitution
           FROM izl_t_security_deposit WHERE lease_id = $1`,
        [id],
      ),
    ]);
    return { ...row, dette, credit_disponible: credit.rows[0].total, caution: caution.rows[0] ?? null };
  }

  // Dette cumulee detaillee, dans l'ordre FIFO : creances de reprise (date limite croissante) puis loyers (mois croissant)
  async debt(user: AuthUser, id: number) {
    await this.loadAccessible(user, id);
    const e = await this.db.query(
      `SELECT id, type, mois, libelle, montant_du, montant_percu,
              (montant_du - montant_percu) AS reste, statut_paiement, est_en_retard, date_echeance,
              (COALESCE(mois, date_echeance) < date_trunc('month', now() AT TIME ZONE 'Africa/Abidjan')::date) AS est_report
         FROM izl_t_installment
        WHERE lease_id = $1
        ORDER BY (type = 'LOYER'), COALESCE(mois, date_echeance), id`,
      [id],
    );
    return { dette: await this.debtSummary(id), echeances: e.rows };
  }

  private async debtSummary(leaseId: number) {
    const r = await this.db.query(
      `SELECT dette_totale::bigint AS totale, dont_reports::bigint AS dont_reports,
              nb_echeances_ouvertes, a_un_retard
         FROM izl_v_lease_debt WHERE lease_id = $1`,
      [leaseId],
    );
    return r.rows[0];
  }

  // Bailleur du bail OU locataire du bail ; sinon "introuvable"
  private async loadAccessible(user: AuthUser, id: number) {
    const r = await this.db.query(
      `SELECT l.id, l.local_id, l.locataire_id, l.numero_wave, l.loyer_mensuel, l.jour_limite,
              l.date_debut_contrat, l.date_prise_effet, l.date_fin, l.statut,
              lo.designation AS local, st.id AS site_id, st.nom AS site, st.proprietaire_id,
              u.nom AS locataire_nom, u.prenoms AS locataire_prenoms, u.telephone AS locataire_telephone
         FROM izl_t_lease l
         JOIN izl_t_local lo ON lo.id = l.local_id
         JOIN izl_t_site  st ON st.id = lo.site_id
         JOIN izl_t_user  u  ON u.id  = l.locataire_id
        WHERE l.id = $1`,
      [id],
    );
    const row = r.rows[0];
    if (!row || (row.proprietaire_id !== user.id && row.locataire_id !== user.id)) {
      throw new NotFoundException('Bail introuvable');
    }
    return row;
  }

  // ================================================================== cloture
  async terminate(owner: AuthUser, id: number, dto: TerminateLeaseDto) {
    const today = todayAbidjan();
    this.requireDate(dto.date_fin, 'date_fin');
    try {
      return await this.db.transaction(async (c) => {
        const r = await c.query<{ statut: string; date_prise_effet: string }>(
          `SELECT l.statut, l.date_prise_effet
             FROM izl_t_lease l
             JOIN izl_t_local lo ON lo.id = l.local_id
             JOIN izl_t_site  st ON st.id = lo.site_id
            WHERE l.id = $1 AND st.proprietaire_id = $2
            FOR UPDATE OF l`,
          [id, owner.id],
        );
        const lease = r.rows[0];
        if (!lease) throw new NotFoundException('Bail introuvable');
        if (lease.statut !== 'ACTIF') throw new ConflictException('Ce bail est deja clos');
        if (dto.date_fin < lease.date_prise_effet) throw new BadRequestException('La date de fin precede la prise d effet');

        // La cloture est impossible tant qu'un paiement est en cours (SFD-03)
        const pending = await c.query(
          `SELECT 1 FROM izl_t_checkout_session WHERE lease_id = $1 AND statut = 'OUVERTE'
           UNION ALL
           SELECT 1 FROM izl_t_transfer_verification WHERE lease_id = $1 AND statut = 'EN_VERIFICATION'`,
          [id],
        );
        if (pending.rows.length > 0) {
          throw new ConflictException('Un paiement est en cours (session de paiement ou verification de virement) : reessayez plus tard');
        }

        // Date passee ou du jour : clos maintenant. Date future : reste actif jusqu'a la date (bascule par le cron quotidien, etape 8).
        const statut = dto.date_fin <= today ? dto.type ?? 'RESILIE' : 'ACTIF';
        await c.query('UPDATE izl_t_lease SET date_fin = $2, statut = $3 WHERE id = $1', [id, dto.date_fin, statut]);
        await c.query(
          `INSERT INTO izl_t_audit_log (acteur_id, lease_id, evenement, details) VALUES ($1, $2, 'CLOTURE_BAIL', $3)`,
          [owner.id, id, JSON.stringify({ date_fin: dto.date_fin, statut })],
        );
        return { id, statut, date_fin: dto.date_fin };
      });
    } catch (e) {
      translateDbError(e);
    }
  }

  // ================================================================== outils
  private requireDate(s: string, champ: string) {
    if (!isValidDate(s)) throw new BadRequestException(`${champ} : date invalide (format AAAA-MM-JJ)`);
  }

  private async findOrCreateTenant(c: PoolClient, tel: string, nom: string, prenoms: string): Promise<number> {
    const u = await c.query<{ id: number; role: string }>('SELECT id, role FROM izl_t_user WHERE telephone = $1', [tel]);
    if (u.rows.length > 0) {
      if (u.rows[0].role !== 'LOCATAIRE') {
        throw new ConflictException('Ce numero appartient deja a un compte bailleur : un locataire doit avoir un compte locataire');
      }
      return u.rows[0].id;
    }
    const ins = await c.query<{ id: number }>(
      `INSERT INTO izl_t_user (nom, prenoms, telephone, role) VALUES ($1, $2, $3, 'LOCATAIRE') RETURNING id`,
      [nom, prenoms, tel],
    );
    return ins.rows[0].id;
  }

  // Texte sans accents (un seul SMS, jeu GSM-7)
  private invitationMessage(loyer: number, jour: number): string {
    return `IziLoyer: votre bailleur a cree votre bail (loyer ${loyer} F/mois, a payer avant le ${jour} du mois). Connectez-vous avec ce numero pour payer.`;
  }

  // Apres validation de la transaction : un echec d'envoi ne doit jamais annuler le bail
  private async sendInvitation(leaseId: number, tel: string, loyer: number, jour: number) {
    const cle = `INVITATION-BAIL-${leaseId}`;
    try {
      await this.sms.send(tel, this.invitationMessage(loyer, jour));
      await this.db.query(`UPDATE izl_t_sms_log SET statut = 'ENVOYE', date_envoi = now() WHERE cle_idempotence = $1`, [cle]);
    } catch (e) {
      this.logger.error(`SMS d'invitation (bail ${leaseId}) : ${(e as Error).message}`);
      await this.db.query(`UPDATE izl_t_sms_log SET statut = 'ECHEC' WHERE cle_idempotence = $1`, [cle]);
    }
  }
}
