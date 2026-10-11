import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class RequestOtpDto {
  @IsString()
  telephone!: string;
}

export class VerifyOtpDto {
  @IsString()
  telephone!: string;

  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'Le code doit contenir 6 chiffres' })
  code!: string;

  // Uniquement a la toute premiere connexion (creation du profil)
  @IsOptional() @IsString() @MaxLength(80)
  nom?: string;

  @IsOptional() @IsString() @MaxLength(120)
  prenoms?: string;

  @IsOptional() @IsIn(['PROPRIETAIRE', 'LOCATAIRE'])
  role?: 'PROPRIETAIRE' | 'LOCATAIRE';

  @IsOptional() @IsEmail()
  email?: string;
}

export class RefreshDto {
  @IsString()
  refresh_token!: string;
}
