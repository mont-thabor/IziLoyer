import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { SmsProvider } from '../auth/sms/sms.provider';
import { translateDbError } from '../common/db-errors';
import { DatabaseService } from '../database/database.service';
import { isValidDate, todayAbidjan } from '../leases/lease-dates';

// ---------------------------------------------------------------- types d'entree
export interface WaveEventInput {
  transactionId: string;
  eventType: string;
  source: 'WEBHOOK' | 'RECONCILIATION' | 'VERIF_VOIE_B';
  statutBrut?: string;
  montant: number;               // TOUJOURS le montant renvoye par Wave, jamais la saisie du client
  payload?: unknown;
}

export type PaymentInput =
  | { voie: 'A' | 'B'; leaseId: number; event: WaveEventInput }
  | {
      voie: 'C';                 // especes, saisies par le bailleur
      leaseId: number;
      montant: number;
      dateRemise: string;        // AAAA-MM-JJ
      saisiPar: number;          // le bailleur
      idempotencyKey: string;
      confirmerDepassement?: boolean;
      confirmerDoublon?: boolean;
    };

export interface PaymentResult {
  status: 'CREATED' | 'DUPLICATE';   // DUPLICATE : evenement ou cle deja traites, aucun effet
  paymentId: number;
  montant: number;
  allocations: { installmentId: number; montant: number; recu: 'ACOMPTE' | 'SOLDE' }[];
  surplus: number;                    // montant mis en credit (avoir)
  detteRestante: number | null;       // null pour un DUPLICATE
}

interface LeaseCtx {
  id: number;
  loyer_mensuel: number;
  date_prise_effet: string;
  proprietaire_id: number;
  designation: string;
  locataire_tel: string;
  locataire_nom: string;
  owner_tel: string;
}
interface PendingSms {
  to: string;
  message: string;
  cle: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(private readonly db: DatabaseService, private readonly sms: SmsProvider) {}

  // ==================================================================================
  // Traitement unique d'un paiement (SFD-04 4.6, STD 4.3), appelable par toutes les voies.
  // UNE SEULE transaction : tout est enregistre, ou rien.
  // Les SMS sont journalises dans la transaction, puis envoyes APRES la validation.
  // ==================================================================================
  async processPayment(input: PaymentInput): Promise<PaymentResult> {
    const today = todayAbidjan();
    const montant = input.voie === 'C' ? input.montant : input.event.montant;
    if (!Number.isInteger(montant) || montant <= 0) throw new BadRequestException('Montant invalide');
    if (input.voie === 'C') {
      if (!isValidDate(input.dateRemise)) throw new BadRequestException('Date de remise invalide (format AAAA-MM-JJ)');
      if (input.dateRemise > today) throw new BadRequestException('La date de remise ne peut pas etre dans le futur');
      if (!input.idempotencyKey) throw new BadRequestException('Cle d idempotence obligatoire');
    }

    const pending: PendingSms[] = [];
    let result: PaymentResult;
    try {
      result = await this.db.transaction((c) => this.run(c, input, montant, today, pending));
    } catch (e) {
      translateDbError(e);
    }
    await this.deliver(pending);
    return result;
  }

  private async run(
    c: PoolClient,
    input: PaymentInput,
    montant: number,
    today: string,
    pending: PendingSms[],
  ): Promise<PaymentResult> {
    // ---- 1. Unicite de l'evenement Wave (idempotence niveau 1) : un evenement rejoue n'a aucun effet.
    //         Deux livraisons simultanees : la seconde ATTEND la premiere, puis constate le doublon.
    let eventId: number | null = null;
    if (input.voie !== 'C') {
      const e = input.event;
      const ins = await c.query<{ id: number }>(
        `INSERT INTO izl_t_wave_event (transaction_id, event_type, source, statut_brut, montant_brut, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (transaction_id, event_type) DO NOTHING
         RETURNING id`,
        [e.transactionId, e.eventType, e.source, e.statutBrut ?? null, e.montant, JSON.stringify(e.payload ?? {})],
      );
      if (ins.rows.length === 0) {
        const p = await c.query<{ id: number }>(
          `SELECT p.id FROM izl_t_payment p JOIN izl_t_wave_event w ON w.id = p.wave_event_id
            WHERE w.transaction_id = $1 AND w.event_type = $2`,
          [e.transactionId, e.eventType],
        );
        return this.duplicate(p.rows[0]?.id ?? 0, montant);
      }
      eventId = ins.rows[0].id;
    }

    // ---- 2. Verrouillage du bail : serialise tous les paiements concurrents du meme bail
    const lr = await c.query<LeaseCtx>(
      `SELECT l.id, l.loyer_mensuel, l.date_prise_effet, st.proprietaire_id, lo.designation,
              tu.telephone AS locataire_tel, tu.nom AS locataire_nom, ou.telephone AS owner_tel
         FROM izl_t_lease l
         JOIN izl_t_local lo ON lo.id = l.local_id
         JOIN izl_t_site  st ON st.id = lo.site_id
         JOIN izl_t_user  tu ON tu.id = l.locataire_id
         JOIN izl_t_user  ou ON ou.id = st.proprietaire_id
        WHERE l.id = $1
        FOR UPDATE OF l`,
      [input.leaseId],
    );
    const lease = lr.rows[0];
    if (!lease) throw new NotFoundException('Bail introuvable');

    // ---- 3. Garde-fous propres aux especes (Voie C)
    if (input.voie === 'C') {
      if (lease.proprietaire_id !== input.saisiPar) throw new NotFoundException('Bail introuvable');
      if (input.dateRemise < lease.date_prise_effet) {
        throw new BadRequestException('La date de remise precede la prise d effet du bail');
      }
      const same = await c.query<{ id: number }>(
        `SELECT id FROM izl_t_payment WHERE lease_id = $1 AND voie = 'C' AND idempotency_key = $2`,
        [lease.id, input.idempotencyKey],
      );
      if (same.rows.length > 0) return this.duplicate(same.rows[0].id, montant);

      if (!input.confirmerDoublon) {
        const recent = await c.query(
          `SELECT 1 FROM izl_t_payment
            WHERE lease_id = $1 AND voie = 'C' AND montant = $2 AND created_at > now() - interval '10 minutes'`,
          [lease.id, montant],
        );
        if (recent.rows.length > 0) {
          throw new ConflictException({
            code: 'DOUBLON_PROBABLE',
            message: 'Un paiement du meme montant a ete saisi il y a moins de 10 minutes sur ce bail. Confirmez pour l enregistrer quand meme.',
          });
        }
      }
    }

    // ---- 4. Plan d'allocation FIFO : creances de reprise (date limite croissante), puis loyers (mois croissant)
    const open = await c.query<{ id: number; montant_du: number; montant_percu: number }>(
      `SELECT id, montant_du, montant_percu FROM izl_t_installment
        WHERE lease_id = $1 AND montant_percu < montant_du
        ORDER BY (type = 'LOYER'), COALESCE(mois, date_echeance), id
        FOR UPDATE`,
      [lease.id],
    );
    const detteAvant = open.rows.reduce((s, r) => s + (r.montant_du - r.montant_percu), 0);
    let reste = montant;
    const plan: { id: number; take: number; solde: boolean }[] = [];
    for (const i of open.rows) {
      if (reste <= 0) break;
      const take = Math.min(reste, i.montant_du - i.montant_percu);
      plan.push({ id: i.id, take, solde: i.montant_percu + take >= i.montant_du });
      reste -= take;
    }
    const surplus = reste;

    // Voie C : un depassement exige une confirmation explicite (il devient un avoir)
    if (input.voie === 'C' && surplus > 0 && !input.confirmerDepassement) {
      throw new ConflictException({
        code: 'DEPASSEMENT',
        message: 'Le montant saisi depasse la dette. Confirmez pour enregistrer l excedent comme avoir.',
        montant,
        dette: detteAvant,
        excedent: surplus,
        equivalent_loyers: this.equivalent(surplus, lease.loyer_mensuel),
      });
    }

    // ---- 5. Mode degrade (SFD-07 7.4) : l'encaissement n'est JAMAIS bloque ; seules les quittances PDF sont differees
    const sub = await c.query<{ statut: string }>('SELECT statut FROM izl_t_owner_subscription WHERE owner_id = $1', [lease.proprietaire_id]);
    const statutRecu = sub.rows[0]?.statut === 'DEGRADE' ? 'EN_ATTENTE_ABONNEMENT' : 'A_GENERER';

    // ---- 6. Le versement (le surplus eventuel devient un credit)
    const pay =
      input.voie === 'C'
        ? await c.query<{ id: number }>(
            `INSERT INTO izl_t_payment
               (lease_id, voie, montant, excedent_initial, excedent_restant, date_remise, saisi_par, idempotency_key)
             VALUES ($1, 'C', $2, $3, $3, $4, $5, $6) RETURNING id`,
            [lease.id, montant, surplus, input.dateRemise, input.saisiPar, input.idempotencyKey],
          )
        : await c.query<{ id: number }>(
            `INSERT INTO izl_t_payment (lease_id, wave_event_id, voie, montant, excedent_initial, excedent_restant)
             VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
            [lease.id, eventId, input.voie, montant, surplus],
          );
    const paymentId = pay.rows[0].id;

    // ---- 7. Allocations + incrementation atomique + une quittance par allocation (numerotee par le trigger)
    const allocations: PaymentResult['allocations'] = [];
    for (const p of plan) {
      const a = await c.query<{ id: number }>(
        `INSERT INTO izl_t_payment_allocation (payment_id, installment_id, montant, source)
         VALUES ($1, $2, $3, 'PAIEMENT') RETURNING id`,
        [paymentId, p.id, p.take],
      );
      await c.query('UPDATE izl_t_installment SET montant_percu = montant_percu + $2 WHERE id = $1', [p.id, p.take]);
      const type = p.solde ? 'SOLDE' : 'ACOMPTE';
      await c.query(
        `INSERT INTO izl_t_receipt (lease_id, installment_id, allocation_id, type, statut_generation)
         VALUES ($1, $2, $3, $4, $5)`,
        [lease.id, p.id, a.rows[0].id, type, statutRecu],
      );
      allocations.push({ installmentId: p.id, montant: p.take, recu: type });
    }
    if (plan.length > 0) {
      await c.query(
        `UPDATE izl_t_installment SET est_en_retard = (date_echeance < $2::date AND statut_paiement <> 'PAYE') WHERE id = ANY($1)`,
        [plan.map((p) => p.id), today],
      );
    }

    // ---- 8. Surplus : quittance d'avance immediate (une seule par paiement)
    if (surplus > 0) {
      await c.query(
        `INSERT INTO izl_t_receipt (lease_id, payment_id, type, statut_generation) VALUES ($1, $2, 'AVANCE', $3)`,
        [lease.id, paymentId, statutRecu],
      );
    }

    if (eventId !== null) await c.query('UPDATE izl_t_wave_event SET traite = true WHERE id = $1', [eventId]);

    // ---- 9. Trace (especes) et SMS de confirmation, journalises dans la transaction
    if (input.voie === 'C') {
      await c.query(
        `INSERT INTO izl_t_audit_log (acteur_id, lease_id, evenement, details) VALUES ($1, $2, 'PAIEMENT_ESPECES', $3)`,
        [input.saisiPar, lease.id, JSON.stringify({ payment_id: paymentId, montant, date_remise: input.dateRemise, surplus })],
      );
    }
    const detteRestante = Math.max(0, detteAvant - (montant - surplus));
    const dateTxt = this.shortDate(input.voie === 'C' ? input.dateRemise : today);
    const suffixe =
      surplus > 0
        ? ` Votre avoir: ${surplus} F, soit ${this.equivalent(surplus, lease.loyer_mensuel)}.`
        : detteRestante > 0
          ? ` Reste a payer: ${detteRestante} F.`
          : ' Vous etes a jour.';
    const smsLocataire =
      input.voie === 'C'
        ? `IziLoyer: paiement en especes de ${montant} F enregistre par votre bailleur le ${dateTxt}.${suffixe}`
        : `IziLoyer: paiement de ${montant} F recu le ${dateTxt}.${suffixe}`;
    await this.queueSms(c, pending, lease.locataire_tel, 'CONFIRMATION_PAIEMENT', `CONF-PAIEMENT-${paymentId}`, smsLocataire);
    if (input.voie !== 'C') {
      await this.queueSms(
        c,
        pending,
        lease.owner_tel,
        'CONFIRMATION_PAIEMENT_BAILLEUR',
        `CONF-PAIEMENT-BAILLEUR-${paymentId}`,
        `IziLoyer: ${lease.locataire_nom} a paye ${montant} F (${lease.designation}) le ${dateTxt}.`,
      );
    }

    return { status: 'CREATED', paymentId, montant, allocations, surplus, detteRestante };
  }

  // ==================================================================================
  // Outils
  // ==================================================================================
  private duplicate(paymentId: number, montant: number): PaymentResult {
    return { status: 'DUPLICATE', paymentId, montant, allocations: [], surplus: 0, detteRestante: null };
  }

  // "N loyer(s) entier(s) + reste" (SFD-04 4.10)
  private equivalent(avoir: number, loyer: number): string {
    const n = Math.floor(avoir / loyer);
    const reste = avoir - n * loyer;
    if (n === 0) return 'moins d un loyer';
    return reste > 0 ? `${n} loyer(s) + ${reste} F` : `${n} loyer(s)`;
  }

  private shortDate(d: string): string {
    return `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  }

  private async queueSms(c: PoolClient, pending: PendingSms[], to: string, type: string, cle: string, message: string) {
    const r = await c.query(
      `INSERT INTO izl_t_sms_log (destinataire, type, cle_idempotence, statut, contenu)
       VALUES ($1, $2, $3, 'A_ENVOYER', $4)
       ON CONFLICT (cle_idempotence) DO NOTHING RETURNING id`,
      [to, type, cle, message],
    );
    if (r.rows.length > 0) pending.push({ to, message, cle });
  }

  // Apres validation : un echec d'envoi ne remet jamais en cause le paiement (statut ECHEC, reessai possible plus tard)
  private async deliver(pending: PendingSms[]) {
    for (const s of pending) {
      try {
        await this.sms.send(s.to, s.message);
        await this.db.query(`UPDATE izl_t_sms_log SET statut = 'ENVOYE', date_envoi = now() WHERE cle_idempotence = $1`, [s.cle]);
      } catch (e) {
        this.logger.error(`SMS ${s.cle} : ${(e as Error).message}`);
        await this.db.query(`UPDATE izl_t_sms_log SET statut = 'ECHEC' WHERE cle_idempotence = $1`, [s.cle]);
      }
    }
  }
}
