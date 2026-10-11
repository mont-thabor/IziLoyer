// Tests d'integration : ils utilisent la VRAIE base Docker (port du .env).
// Chaque test utilise son propre numero de telephone ; tout est nettoye a la fin.
import { HttpException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../database/database.module';
import { DatabaseService } from '../database/database.service';
import { AuthService } from './auth.service';
import { SmsProvider } from './sms/sms.provider';

class FakeSms extends SmsProvider {
  last = '';
  async send(_to: string, message: string): Promise<void> {
    this.last = message;
  }
}

describe('AuthService (integration, base reelle)', () => {
  let mod: TestingModule;
  let svc: AuthService;
  let db: DatabaseService;
  const sms = new FakeSms();
  const phones: string[] = [];

  const newTel = () => {
    const t = '+22599' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
    phones.push(t);
    return t;
  };
  const lastCode = () => /(\d{6})/.exec(sms.last)![1];
  const profil = { nom: 'Test', prenoms: 'Auto', role: 'LOCATAIRE' as const };
  const statusOf = async (p: Promise<unknown>): Promise<number> => {
    try {
      await p;
      return 200;
    } catch (e) {
      return (e as HttpException).getStatus();
    }
  };
  const backdateCreated = (tel: string, minutes: number) =>
    db.query(
      `UPDATE izl_t_otp_code SET created_at = created_at - make_interval(mins => $2) WHERE telephone = $1`,
      [tel, minutes],
    );

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule, JwtModule.register({})],
      providers: [AuthService, { provide: SmsProvider, useValue: sms }],
    }).compile();
    svc = mod.get(AuthService);
    db = mod.get(DatabaseService);
  });

  afterAll(async () => {
    await db.query(
      `DELETE FROM izl_t_refresh_token WHERE user_id IN (SELECT id FROM izl_t_user WHERE telephone = ANY($1))`,
      [phones],
    );
    await db.query('DELETE FROM izl_t_user WHERE telephone = ANY($1)', [phones]);
    await db.query('DELETE FROM izl_t_otp_code WHERE telephone = ANY($1)', [phones]);
    await db.query('DELETE FROM izl_t_sms_log WHERE destinataire = ANY($1)', [phones]);
    await mod.close();
  });

  it('numero invalide -> 400', async () => {
    expect(await statusOf(svc.requestOtp('abc'))).toBe(400);
  });

  it('code correct -> session ; le meme code ne peut pas resservir (usage unique)', async () => {
    const tel = newTel();
    await svc.requestOtp(tel);
    const code = lastCode();
    const s = await svc.verifyOtp({ telephone: tel, code, ...profil });
    expect(s.access_token).toBeTruthy();
    expect(s.refresh_token).toBeTruthy();
    expect(s.user.role).toBe('LOCATAIRE');
    expect(await statusOf(svc.verifyOtp({ telephone: tel, code, ...profil }))).toBe(401);
  });

  it('critere 15 : 3 codes errones -> blocage, meme le bon code est refuse, nouveau code soumis au delai', async () => {
    const tel = newTel();
    await svc.requestOtp(tel);
    const good = lastCode();
    const bad = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i++) {
      expect(await statusOf(svc.verifyOtp({ telephone: tel, code: bad, ...profil }))).toBe(401);
    }
    expect(await statusOf(svc.verifyOtp({ telephone: tel, code: good, ...profil }))).toBe(401);
    expect(await statusOf(svc.requestOtp(tel))).toBe(429); // delai progressif
  });

  it('delai progressif : 2e demande immediate refusee, acceptee apres 2 minutes', async () => {
    const tel = newTel();
    await svc.requestOtp(tel);
    expect(await statusOf(svc.requestOtp(tel))).toBe(429);
    await backdateCreated(tel, 2);
    expect(await statusOf(svc.requestOtp(tel))).toBe(200);
  });

  it('anti-flooding : 4e demande dans la meme heure refusee', async () => {
    const tel = newTel();
    await svc.requestOtp(tel);
    await backdateCreated(tel, 3);
    await svc.requestOtp(tel);
    await backdateCreated(tel, 3);
    await svc.requestOtp(tel);
    await backdateCreated(tel, 6);
    expect(await statusOf(svc.requestOtp(tel))).toBe(429);
  });

  it('code expire -> 401', async () => {
    const tel = newTel();
    await svc.requestOtp(tel);
    const code = lastCode();
    await db.query(`UPDATE izl_t_otp_code SET expires_at = now() - interval '1 minute' WHERE telephone = $1`, [tel]);
    expect(await statusOf(svc.verifyOtp({ telephone: tel, code, ...profil }))).toBe(401);
  });

  it('premiere connexion sans profil -> 400, et le code reste utilisable', async () => {
    const tel = newTel();
    await svc.requestOtp(tel);
    const code = lastCode();
    expect(await statusOf(svc.verifyOtp({ telephone: tel, code }))).toBe(400);
    const s = await svc.verifyOtp({ telephone: tel, code, ...profil });
    expect(s.access_token).toBeTruthy();
  });

  it('refresh : rotation, et rejeu de l ancien jeton -> toutes les sessions coupees', async () => {
    const tel = newTel();
    await svc.requestOtp(tel);
    const s1 = await svc.verifyOtp({ telephone: tel, code: lastCode(), ...profil });
    const s2 = await svc.refresh(s1.refresh_token);
    expect(s2.refresh_token).not.toBe(s1.refresh_token);
    expect(await statusOf(svc.refresh(s1.refresh_token))).toBe(401); // ancien jeton rejoue
    expect(await statusOf(svc.refresh(s2.refresh_token))).toBe(401); // la famille est revoquee
  });

  it('logout : le jeton de rafraichissement ne marche plus', async () => {
    const tel = newTel();
    await svc.requestOtp(tel);
    const s = await svc.verifyOtp({ telephone: tel, code: lastCode(), ...profil });
    await svc.logout(s.refresh_token);
    expect(await statusOf(svc.refresh(s.refresh_token))).toBe(401);
  });
});
