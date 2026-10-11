// Tests d'integration : vraie base Docker, donnees de test nettoyees a la fin.
import { HttpException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../database/database.module';
import { DatabaseService } from '../database/database.service';
import { Fixtures } from '../testing/fixtures';
import { PropertiesService } from './properties.service';

describe('PropertiesService (integration, base reelle)', () => {
  let mod: TestingModule;
  let svc: PropertiesService;
  let db: DatabaseService;
  let fx: Fixtures;

  const statusOf = async (p: Promise<unknown>): Promise<number> => {
    try {
      await p;
      return 200;
    } catch (e) {
      return (e as HttpException).getStatus();
    }
  };

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
      providers: [PropertiesService],
    }).compile();
    svc = mod.get(PropertiesService);
    db = mod.get(DatabaseService);
    fx = new Fixtures(db);
  });

  afterAll(async () => {
    await fx.cleanup();
    await mod.close();
  });

  it('site et local : creation, doublon de designation refuse (409)', async () => {
    const o = await fx.mkOwner();
    const site = await svc.createSite(o.id, { nom: 'Residence A', commune: 'Cocody' });
    expect(site.ville).toBe('Abidjan');
    const local = await svc.createLocal(o.id, site.id, { designation: 'Studio 1', type: 'Studio', loyer_mensuel: 100000 });
    expect(local.loyer_mensuel).toBe(100000);
    expect(
      await statusOf(svc.createLocal(o.id, site.id, { designation: 'Studio 1', type: 'Studio', loyer_mensuel: 90000 })),
    ).toBe(409);
  });

  it('un site d un autre bailleur est introuvable (404)', async () => {
    const a = await fx.mkOwner();
    const b = await fx.mkOwner();
    const site = await svc.createSite(a.id, { nom: 'Residence B', commune: 'Plateau' });
    expect(await statusOf(svc.listLocals(b.id, site.id))).toBe(404);
    expect(
      await statusOf(svc.createLocal(b.id, site.id, { designation: 'X', type: 'Studio', loyer_mensuel: 1000 })),
    ).toBe(404);
  });

  it('statut Libre / Loue derive du bail actif (SFD-02)', async () => {
    const o = await fx.mkOwner();
    const site = await svc.createSite(o.id, { nom: 'Residence C', commune: 'Yopougon' });
    const local = await svc.createLocal(o.id, site.id, { designation: 'A1', type: '2 pieces', loyer_mensuel: 150000 });
    let locals = await svc.listLocals(o.id, site.id);
    expect(locals[0].statut).toBe('LIBRE');

    const tenant = await db.query<{ id: number }>(
      `INSERT INTO izl_t_user (nom, prenoms, telephone, role) VALUES ('Loc', 'Test', $1, 'LOCATAIRE') RETURNING id`,
      [fx.phone()],
    );
    await db.query(
      `INSERT INTO izl_t_lease (local_id, locataire_id, numero_wave, loyer_mensuel, date_prise_effet)
       VALUES ($1, $2, '+2250500000000', 150000, current_date)`,
      [local.id, tenant.rows[0].id],
    );
    locals = await svc.listLocals(o.id, site.id);
    expect(locals[0].statut).toBe('LOUE');
    const sites = await svc.listSites(o.id);
    expect(sites[0].nb_locaux).toBe(1);
    expect(sites[0].nb_loues).toBe(1);
    // le locataire cree ici n'appartient a aucun bail "service" : nettoye avec le bailleur
    // (cleanup retrouve les locataires via les baux)
  });
});
