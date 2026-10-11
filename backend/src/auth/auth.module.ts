import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ConsoleSmsProvider, SmsProvider } from './sms/sms.provider';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAuthGuard,
    // Pour passer au vrai fournisseur SMS, remplacer uniquement cette ligne
    { provide: SmsProvider, useClass: ConsoleSmsProvider },
  ],
  exports: [JwtAuthGuard, JwtModule],
})
export class AuthModule {}
