import {
  BadRequestException,
  ConflictException,
  HttpException,
  UnprocessableEntityException,
} from '@nestjs/common';

// Messages lisibles pour les contraintes de la base les plus courantes
const CONSTRAINT_MESSAGES: Record<string, string> = {
  izl_ix_lease_local_actif: 'Ce local a deja un bail actif.',
  izl_uq_local_designation: 'Cette designation existe deja dans ce site.',
  izl_uq_user_email: 'Cet email est deja utilise.',
};

// Convertit une erreur PostgreSQL en reponse HTTP claire.
// - 23505 (doublon)            -> 409
// - 23514 / 22P02 / 22003 / 23502 (donnee invalide) -> 400
// - P0001 (regle metier levee par un trigger) -> 422 avec le message du trigger
export function translateDbError(e: any): never {
  if (e instanceof HttpException) throw e;
  switch (e?.code) {
    case '23505':
      throw new ConflictException(
        CONSTRAINT_MESSAGES[e.constraint] ?? 'Cette operation entre en conflit avec une donnee existante.',
      );
    case '23514':
    case '22P02':
    case '22003':
    case '23502':
      throw new BadRequestException(CONSTRAINT_MESSAGES[e.constraint] ?? `Donnees invalides (${e.constraint ?? e.message}).`);
    case 'P0001':
      throw new UnprocessableEntityException(String(e.message));
  }
  throw e;
}
