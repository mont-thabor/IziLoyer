import { Injectable, NotFoundException } from '@nestjs/common';
import { translateDbError } from '../common/db-errors';
import { DatabaseService } from '../database/database.service';
import { CreateLocalDto, CreateSiteDto } from './properties.dto';

@Injectable()
export class PropertiesService {
  constructor(private readonly db: DatabaseService) {}

  async createSite(ownerId: number, dto: CreateSiteDto) {
    try {
      const r = await this.db.query(
        `INSERT INTO izl_t_site (proprietaire_id, nom, commune, ville)
         VALUES ($1, $2, $3, COALESCE($4, 'Abidjan'))
         RETURNING id, nom, commune, ville`,
        [ownerId, dto.nom, dto.commune, dto.ville ?? null],
      );
      return r.rows[0];
    } catch (e) {
      translateDbError(e);
    }
  }

  async listSites(ownerId: number) {
    const r = await this.db.query(
      `SELECT st.id, st.nom, st.commune, st.ville,
              count(lo.id)                                    AS nb_locaux,
              count(lo.id) FILTER (WHERE b.id IS NOT NULL)    AS nb_loues
         FROM izl_t_site st
         LEFT JOIN izl_t_local lo ON lo.site_id = st.id
         LEFT JOIN izl_t_lease b  ON b.local_id = lo.id AND b.statut = 'ACTIF'
        WHERE st.proprietaire_id = $1
        GROUP BY st.id
        ORDER BY st.nom`,
      [ownerId],
    );
    return r.rows;
  }

  async createLocal(ownerId: number, siteId: number, dto: CreateLocalDto) {
    await this.assertSiteOwner(ownerId, siteId);
    try {
      const r = await this.db.query(
        `INSERT INTO izl_t_local (site_id, designation, type, loyer_mensuel)
         VALUES ($1, $2, $3, $4)
         RETURNING id, site_id, designation, type, loyer_mensuel`,
        [siteId, dto.designation, dto.type, dto.loyer_mensuel],
      );
      return r.rows[0];
    } catch (e) {
      translateDbError(e);
    }
  }

  // Le statut Libre / Loue est DERIVE de l'existence d'un bail actif (SFD-02), jamais stocke.
  async listLocals(ownerId: number, siteId: number) {
    await this.assertSiteOwner(ownerId, siteId);
    const r = await this.db.query(
      `SELECT lo.id, lo.designation, lo.type, lo.loyer_mensuel,
              CASE WHEN b.id IS NULL THEN 'LIBRE' ELSE 'LOUE' END AS statut,
              b.id AS bail_actif_id
         FROM izl_t_local lo
         LEFT JOIN izl_t_lease b ON b.local_id = lo.id AND b.statut = 'ACTIF'
        WHERE lo.site_id = $1
        ORDER BY lo.designation`,
      [siteId],
    );
    return r.rows;
  }

  // Un site d'un autre bailleur est traite comme introuvable (on ne revele pas son existence)
  private async assertSiteOwner(ownerId: number, siteId: number) {
    const r = await this.db.query('SELECT 1 FROM izl_t_site WHERE id = $1 AND proprietaire_id = $2', [siteId, ownerId]);
    if (r.rows.length === 0) throw new NotFoundException('Site introuvable');
  }
}
