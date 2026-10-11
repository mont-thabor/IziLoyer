import { Global, Module } from '@nestjs/common';
import { ConsoleSmsProvider, SmsProvider } from './sms.provider';

// Module global : n'importe quel module peut injecter SmsProvider.
// Pour passer au vrai fournisseur SMS (P3), remplacer uniquement useClass ci-dessous.
@Global()
@Module({
  providers: [{ provide: SmsProvider, useClass: ConsoleSmsProvider }],
  exports: [SmsProvider],
})
export class SmsModule {}
