import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateSiteDto {
  @IsString() @MinLength(1) @MaxLength(120)
  nom!: string;

  @IsString() @MinLength(1) @MaxLength(80)
  commune!: string;

  @IsOptional() @IsString() @MaxLength(80)
  ville?: string;
}

export class CreateLocalDto {
  @IsString() @MinLength(1) @MaxLength(80)
  designation!: string;

  @IsString() @MinLength(1) @MaxLength(40)
  type!: string;                       // Studio, 2 pieces...

  // Loyer par defaut du local (FCFA, entier) ; le bail porte son propre loyer
  @IsInt() @Min(1) @Max(100_000_000)
  loyer_mensuel!: number;
}
