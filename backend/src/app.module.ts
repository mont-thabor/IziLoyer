import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { SmsModule } from './auth/sms/sms.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { LeasesModule } from './leases/leases.module';
import { PaymentsModule } from './payments/payments.module';
import { PropertiesModule } from './properties/properties.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    SmsModule,
    AuthModule,
    PropertiesModule,
    LeasesModule,
    PaymentsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
