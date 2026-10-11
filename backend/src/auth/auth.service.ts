import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { VerifyOtpDto } from './auth.dto';
import { normalizePhone } from './phone.util';
import { SmsProvider } from './sms/sms.provider';

const OTP_TTL_MIN = 5;                    // validite du code
const MAX_ATTEMPTS = 3;                   // tentatives avant blocage du code
const MAX_REQUESTS_PER_HOUR = 3;          // anti-flooding
const COOLDOWNS_SEC = [60, 120, 300];     // delai avant un nouveau code : apres la 1re, 2e, 3e demande
const ACCESS_TTL_SEC = 15 * 60;

interface UserRow { id: number; role: string }
export interface Session {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: UserRow;
}

type VerifyOutcome =
  | { ok: true; session: Session }
  | { ok: false; reason: 'EXPIRE' | 'INVALIDE' | 'BLOQUE'; restantes?: number };

type RefreshOutcome = { ok: true; session: Session } | { ok: false };

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly sms: SmsProvider,
  ) {}

  // ------------------------------------------------------------------ OTP : demande
  async requestOtp(telephoneBrut: string) {
    const tel = normalizePhone(telephoneBrut);
    if (!tel) throw new BadRequestException('Numero de telephone invalide');

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

    const otpId = await this.db.transaction(async (c) => {
      // Verrou par numero : deux demandes simultanees ne peuvent pas contourner les limites
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['otp:' + tel]);

      const r = await c.query<{ n: number; depuis: number | null }>(
        `SELECT count(*)::int AS n,
                EXTRACT(EPOCH FROM (clock_timestamp() - max(created_at)))::float8 AS depuis
           FROM izl_t_otp_code
          WHERE telephone = $1 AND created_at > now() - interval '1 hour'`,
        [tel],
      );
      const { n, depuis } = r.rows[0];

      if (n >= MAX_REQUESTS_PER_HOUR) {
        throw new HttpException(
          { message: 'Trop de demandes de code. Reessayez dans une heure.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (n >= 1) {
        const attente = COOLDOWNS_SEC[n - 1];
        if (depuis !== null && depuis < attente) {
          throw new HttpException(
            {
              message: 'Veuillez patienter avant de demander un nouveau code.',
              retry_after_secondes: Math.ceil(attente - depuis),
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }

      // Un seul code valide a la fois : les precedents sont invalides
      await c.query('UPDATE izl_t_otp_code SET consomme = true WHERE telephone = $1 AND consomme = false', [tel]);

      const ins = await c.query<{ id: number }>(
        `INSERT INTO izl_t_otp_code (telephone, code_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING id`,
        [tel, this.hash(tel, code), OTP_TTL_MIN],
      );
      return ins.rows[0].id;
    });

    await this.sms.send(
      tel,
      `IziLoyer: votre code est ${code}. Valable ${OTP_TTL_MIN} minutes. Ne le communiquez a personne.`,
    );
    await this.db.query(
      `INSERT INTO izl_t_sms_log (destinataire, type, cle_idempotence, statut, contenu, date_envoi)
       VALUES ($1, 'OTP', $2, 'ENVOYE', 'Code de connexion', now())`,
      [tel, `OTP-${otpId}`],
    );

    return { message: 'Code envoye', expire_dans_secondes: OTP_TTL_MIN * 60 };
  }

  // ------------------------------------------------------------------ OTP : verification
  async verifyOtp(dto: VerifyOtpDto): Promise<Session> {
    const tel = normalizePhone(dto.telephone);
    if (!tel) throw new BadRequestException('Numero de telephone invalide');

    // Premiere connexion : le profil est obligatoire. Verifie AVANT de toucher au code,
    // pour ne pas "brûler" un code valide.
    const existant = await this.db.query<UserRow>('SELECT id, role FROM izl_t_user WHERE telephone = $1', [tel]);
    if (existant.rows.length === 0 && !(dto.nom && dto.prenoms && dto.role)) {
      throw new BadRequestException({
        code: 'PROFIL_REQUIS',
        message: 'Premiere connexion : nom, prenoms et role sont obligatoires.',
      });
    }

    let outcome: VerifyOutcome;
    try {
      outcome = await this.db.transaction<VerifyOutcome>(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['otp:' + tel]);

        const r = await c.query<{ id: number; code_hash: string; tentatives: number }>(
          `SELECT id, code_hash, tentatives FROM izl_t_otp_code
            WHERE telephone = $1 AND consomme = false AND expires_at > now()
            ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [tel],
        );
        const otp = r.rows[0];
        if (!otp) return { ok: false, reason: 'EXPIRE' };

        if (!this.safeEqual(otp.code_hash, this.hash(tel, dto.code))) {
          const t = otp.tentatives + 1;
          const bloque = t >= MAX_ATTEMPTS;
          await c.query('UPDATE izl_t_otp_code SET tentatives = $2, consomme = $3 WHERE id = $1', [otp.id, t, bloque]);
          return { ok: false, reason: bloque ? 'BLOQUE' : 'INVALIDE', restantes: Math.max(0, MAX_ATTEMPTS - t) };
        }

        // Code correct : usage unique
        await c.query('UPDATE izl_t_otp_code SET consomme = true WHERE id = $1', [otp.id]);

        let user: UserRow;
        const u = await c.query<UserRow>('SELECT id, role FROM izl_t_user WHERE telephone = $1', [tel]);
        if (u.rows.length > 0) {
          user = u.rows[0];
        } else {
          const ins = await c.query<UserRow>(
            `INSERT INTO izl_t_user (nom, prenoms, telephone, email, role)
             VALUES ($1, $2, $3, $4, $5) RETURNING id, role`,
            [dto.nom, dto.prenoms, tel, dto.email ?? null, dto.role],
          );
          user = ins.rows[0];
        }
        return { ok: true, session: await this.issueSession(c, user) };
      });
    } catch (e: any) {
      if (e?.code === '23505') {
        throw new ConflictException('Ce telephone ou cet email est deja utilise.');
      }
      throw e;
    }

    if (outcome.ok) return outcome.session;
    if (outcome.reason === 'BLOQUE') {
      throw new UnauthorizedException('Code incorrect. Trop de tentatives : demandez un nouveau code.');
    }
    if (outcome.reason === 'INVALIDE') {
      throw new UnauthorizedException(`Code incorrect. Tentatives restantes : ${outcome.restantes}.`);
    }
    throw new UnauthorizedException('Code invalide ou expire.');
  }

  // ------------------------------------------------------------------ refresh (rotation)
  async refresh(refreshToken: string): Promise<Session> {
    let payload: { sub: string; jti?: string; typ?: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, { secret: this.config.getOrThrow('JWT_REFRESH_SECRET') });
    } catch {
      throw new UnauthorizedException('Session invalide');
    }
    if (payload.typ !== 'refresh' || !payload.jti) throw new UnauthorizedException('Session invalide');

    const result = await this.db.transaction<RefreshOutcome>(async (c) => {
      const r = await c.query<{ id: number; user_id: number; revoque: boolean; valide: boolean }>(
        `SELECT id, user_id, revoque, expires_at > now() AS valide
           FROM izl_t_refresh_token WHERE jti = $1 FOR UPDATE`,
        [payload.jti],
      );
      const row = r.rows[0];
      if (!row) return { ok: false };

      if (row.revoque) {
        // Un jeton deja utilise est presente a nouveau : vol possible -> on coupe toutes les sessions
        await c.query('UPDATE izl_t_refresh_token SET revoque = true WHERE user_id = $1 AND revoque = false', [row.user_id]);
        return { ok: false };
      }
      if (!row.valide) return { ok: false };

      await c.query('UPDATE izl_t_refresh_token SET revoque = true WHERE id = $1', [row.id]);
      const u = await c.query<UserRow>('SELECT id, role FROM izl_t_user WHERE id = $1', [row.user_id]);
      return { ok: true, session: await this.issueSession(c, u.rows[0]) };
    });

    if (!result.ok) throw new UnauthorizedException('Session invalide');
    return result.session;
  }

  // ------------------------------------------------------------------ deconnexion
  async logout(refreshToken: string) {
    try {
      const p = await this.jwt.verifyAsync(refreshToken, { secret: this.config.getOrThrow('JWT_REFRESH_SECRET') });
      if (p.jti) await this.db.query('UPDATE izl_t_refresh_token SET revoque = true WHERE jti = $1', [p.jti]);
    } catch {
      /* jeton deja invalide : rien a faire */
    }
    return { message: 'Deconnecte' };
  }

  // ------------------------------------------------------------------ outils internes
  private async issueSession(c: PoolClient, user: UserRow): Promise<Session> {
    const access_token = await this.jwt.signAsync(
      { sub: String(user.id), role: user.role },
      { secret: this.config.getOrThrow('JWT_ACCESS_SECRET'), expiresIn: '15m' },
    );
    const jti = randomUUID();
    await c.query(
      `INSERT INTO izl_t_refresh_token (user_id, jti, expires_at) VALUES ($1, $2, now() + interval '30 days')`,
      [user.id, jti],
    );
    const refresh_token = await this.jwt.signAsync(
      { sub: String(user.id), jti, typ: 'refresh' },
      { secret: this.config.getOrThrow('JWT_REFRESH_SECRET'), expiresIn: '30d' },
    );
    return { access_token, refresh_token, expires_in: ACCESS_TTL_SEC, user };
  }

  // Le code n'est jamais stocke en clair : HMAC-SHA256 avec un "poivre" secret
  private hash(tel: string, code: string): string {
    return createHmac('sha256', this.config.getOrThrow<string>('OTP_PEPPER')).update(`${tel}:${code}`).digest('hex');
  }

  private safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  }
}
