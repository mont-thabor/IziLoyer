import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async check() {
    const r = await this.db.query<{ nb: number }>(
      'SELECT count(*)::int AS nb FROM izl_t_subscription_tier',
    );
    return { status: 'ok', paliers: r.rows[0].nb };
  }
}
