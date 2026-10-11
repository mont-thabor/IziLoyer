import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CashPaymentDto {
  @IsInt() @Min(1) @Max(1_000_000_000)
  montant!: number;

  // Date de remise des fonds : pas dans le futur, pas avant la prise d'effet du bail
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Format attendu : AAAA-MM-JJ' })
  date_remise!: string;

  // Genere par l'ecran : une double soumission n'enregistre qu'un paiement
  @IsString() @MinLength(8) @MaxLength(64)
  idempotency_key!: string;

  // Si le montant depasse la dette : l'excedent devient un avoir (confirmation explicite)
  @IsOptional() @IsBoolean()
  confirmer_depassement?: boolean;

  // Si un paiement du meme montant a ete saisi il y a moins de 10 minutes
  @IsOptional() @IsBoolean()
  confirmer_doublon?: boolean;
}
