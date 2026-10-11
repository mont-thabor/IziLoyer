import { Injectable, Logger } from '@nestjs/common';

// Contrat d'envoi de SMS. Classe abstraite = sert aussi de "jeton" d'injection NestJS.
// Le vrai fournisseur (P3, a choisir plus tard) n'aura qu'a heriter de cette classe.
export abstract class SmsProvider {
  abstract send(to: string, message: string): Promise<void>;
}

// Version de DEVELOPPEMENT : affiche le SMS dans le terminal au lieu de l'envoyer.
// Ne jamais utiliser en production (le code OTP apparait dans les journaux).
@Injectable()
export class ConsoleSmsProvider extends SmsProvider {
  private readonly logger = new Logger('SMS');

  async send(to: string, message: string): Promise<void> {
    this.logger.log(`SMS -> ${to} : ${message}`);
  }
}
