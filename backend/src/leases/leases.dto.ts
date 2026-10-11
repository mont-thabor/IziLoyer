import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MSG = 'Format attendu : AAAA-MM-JJ';

export class ArrearDto {
  @IsString() @MinLength(1) @MaxLength(120)
  libelle!: string;

  @IsInt() @Min(1) @Max(1_000_000_000)
  montant!: number;

  // Date limite fixee par le bailleur
  @Matches(DATE, { message: DATE_MSG })
  date_limite!: string;
}

export class DepositDto {
  @IsInt() @Min(1) @Max(1_000_000_000)
  montant!: number;

  @Matches(DATE, { message: DATE_MSG })
  date_reception!: string;

  @IsString() @MinLength(1) @MaxLength(60)
  mode!: string;                       // especes, Wave...
}

export class CreateLeaseDto {
  @IsInt() @Min(1)
  local_id!: number;

  @IsString()
  locataire_telephone!: string;

  @IsString() @MinLength(1) @MaxLength(80)
  locataire_nom!: string;

  @IsString() @MinLength(1) @MaxLength(120)
  locataire_prenoms!: string;

  // Numero Wave PAYEUR ; par defaut le telephone du locataire
  @IsOptional() @IsString()
  numero_wave?: string;

  // Par defaut le loyer du local
  @IsOptional() @IsInt() @Min(1) @Max(100_000_000)
  loyer_mensuel?: number;

  // 4 a 28, defaut 5 (D10)
  @IsOptional() @IsInt() @Min(4) @Max(28)
  jour_limite?: number;

  @IsOptional() @Matches(DATE, { message: DATE_MSG })
  date_debut_contrat?: string;

  // Premier mois gere dans IziLoyer : au plus tot le 1er du mois en cours
  @Matches(DATE, { message: DATE_MSG })
  date_prise_effet!: string;

  @IsOptional() @Matches(DATE, { message: DATE_MSG })
  date_fin?: string;

  // Soldes d'ouverture, saisis par le bailleur seul (SFD-03)
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000_000)
  avance?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ArrearDto)
  arrieres?: ArrearDto[];

  @IsOptional() @ValidateNested() @Type(() => DepositDto)
  caution?: DepositDto;
}

export class TerminateLeaseDto {
  @Matches(DATE, { message: DATE_MSG })
  date_fin!: string;

  // Resiliation (anticipee) ou terme (fin normale)
  @IsOptional() @IsIn(['RESILIE', 'TERMINE'])
  type?: 'RESILIE' | 'TERMINE';
}
