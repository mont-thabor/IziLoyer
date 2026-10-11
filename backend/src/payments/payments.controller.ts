import { Body, Controller, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AuthedRequest } from '../common/auth-user';
import { CashPaymentDto } from './payments.dto';
import { PaymentsService } from './payments.service';

// Voie C : paiement en especes enregistre par le bailleur du bail (SFD-04 4.4 bis).
// Les Voies A et B (Wave) arrivent a l'etape 7 ; elles appelleront le meme processPayment().
@Controller('leases')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post(':id/cash-payments')
  @Roles('PROPRIETAIRE')
  cash(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number, @Body() dto: CashPaymentDto) {
    return this.payments.processPayment({
      voie: 'C',
      leaseId: id,
      montant: dto.montant,
      dateRemise: dto.date_remise,
      saisiPar: req.user.id,
      idempotencyKey: dto.idempotency_key,
      confirmerDepassement: dto.confirmer_depassement,
      confirmerDoublon: dto.confirmer_doublon,
    });
  }
}
