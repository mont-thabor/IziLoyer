// Outils de test : creation de bailleurs / locaux de test et NETTOYAGE.
// Les tables d'allocations, d'evenements et de remboursements sont en "append-only" (triggers) :
// le nettoyage desactive donc les triggers le temps de la transaction
// (session_replication_role = replica, reserve au super-utilisateur : c'est le cas de l'utilisateur
// "izl" du conteneur Docker de developpement).
import { DatabaseService } from '../database/database.service';

export class Fixtures {
  readonly owners: number[] = [];
  private seq = 0;
  private readonly used = new Set<string>();

  constructor(private readonly db: DatabaseService) {}

  // Numero de test unique, au format E.164
  phone(): string {
    let t: string;
    do {
      t = '+22597' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
    } while (this.used.has(t));
    this.used.add(t);
    return t;
  }

  async mkOwner(opts: { wave?: boolean; essai?: boolean } = {}): Promise<{ id: number; tel: string }> {
    const tel = this.phone();
    const u = await this.db.query<{ id: number }>(
      `INSERT INTO izl_t_user (nom, prenoms, telephone, role) VALUES ('Bailleur', 'Test', $1, 'PROPRIETAIRE') RETURNING id`,
      [tel],
    );
    const id = u.rows[0].id;
    this.owners.push(id);
    if (opts.wave !== false) {
      await this.db.query(
        `INSERT INTO izl_t_owner_wave_account (owner_id, numero_wave, api_key_chiffree, api_secret_chiffre, webhook_secret_chiffre)
         VALUES ($1, '+2250100000000', 'k', 's', 'w')`,
        [id],
      );
    }
    if (opts.essai) {
      await this.db.query(
        `INSERT INTO izl_t_owner_subscription (owner_id, statut, essai_fin)
         VALUES ($1, 'ESSAI', (now() AT TIME ZONE 'Africa/Abidjan')::date + 90)`,
        [id],
      );
    }
    return { id, tel };
  }

  async mkLocal(ownerId: number, loyer = 100000): Promise<number> {
    let s = await this.db.query<{ id: number }>('SELECT id FROM izl_t_site WHERE proprietaire_id = $1 LIMIT 1', [ownerId]);
    if (s.rows.length === 0) {
      s = await this.db.query<{ id: number }>(
        `INSERT INTO izl_t_site (proprietaire_id, nom, commune) VALUES ($1, 'Immeuble Test', 'Cocody') RETURNING id`,
        [ownerId],
      );
    }
    const l = await this.db.query<{ id: number }>(
      `INSERT INTO izl_t_local (site_id, designation, type, loyer_mensuel) VALUES ($1, $2, 'Studio', $3) RETURNING id`,
      [s.rows[0].id, `L${++this.seq}-${Math.floor(Math.random() * 1e6)}`, loyer],
    );
    return l.rows[0].id;
  }

  async cleanup(): Promise<void> {
    if (this.owners.length === 0) return;
    const O = [this.owners];
    const LEASES = `SELECT l.id FROM izl_t_lease l
                      JOIN izl_t_local lo ON lo.id = l.local_id
                      JOIN izl_t_site  st ON st.id = lo.site_id
                     WHERE st.proprietaire_id = ANY($1)`;
    await this.db.transaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      const t = await c.query<{ id: number }>(
        `SELECT DISTINCT l.locataire_id AS id FROM izl_t_lease l
           JOIN izl_t_local lo ON lo.id = l.local_id
           JOIN izl_t_site  st ON st.id = lo.site_id
          WHERE st.proprietaire_id = ANY($1)`,
        O,
      );
      const tenants = t.rows.map((r) => r.id);
      await c.query(`DELETE FROM izl_t_receipt WHERE lease_id IN (${LEASES})`, O);
      await c.query(
        `DELETE FROM izl_t_payment_allocation WHERE payment_id IN (SELECT id FROM izl_t_payment WHERE lease_id IN (${LEASES}))`,
        O,
      );
      await c.query(`DELETE FROM izl_t_credit_refund WHERE lease_id IN (${LEASES})`, O);
      await c.query(`DELETE FROM izl_t_payment WHERE lease_id IN (${LEASES})`, O);
      await c.query(`DELETE FROM izl_t_installment WHERE lease_id IN (${LEASES})`, O);
      await c.query(`DELETE FROM izl_t_security_deposit WHERE lease_id IN (${LEASES})`, O);
      await c.query(`DELETE FROM izl_t_checkout_session WHERE lease_id IN (${LEASES})`, O);
      await c.query(`DELETE FROM izl_t_transfer_verification WHERE lease_id IN (${LEASES})`, O);
      await c.query(`DELETE FROM izl_t_audit_log WHERE lease_id IN (${LEASES})`, O);
      await c.query(
        `DELETE FROM izl_t_sms_log WHERE cle_idempotence IN (SELECT 'INVITATION-BAIL-' || x.id::text FROM (${LEASES}) x)`,
        O,
      );
      await c.query(`DELETE FROM izl_t_lease WHERE id IN (${LEASES})`, O);
      await c.query(
        `DELETE FROM izl_t_local WHERE site_id IN (SELECT id FROM izl_t_site WHERE proprietaire_id = ANY($1))`,
        O,
      );
      await c.query('DELETE FROM izl_t_site WHERE proprietaire_id = ANY($1)', O);
      await c.query('DELETE FROM izl_t_owner_wave_account WHERE owner_id = ANY($1)', O);
      await c.query('DELETE FROM izl_t_owner_subscription WHERE owner_id = ANY($1)', O);
      await c.query('DELETE FROM izl_t_user WHERE id = ANY($1) OR id = ANY($2)', [this.owners, tenants]);
    });
  }
}
