-- V001__extensions.sql
-- Nécessite un rôle propriétaire de la base.
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid() pour les jti
CREATE EXTENSION IF NOT EXISTS citext;     -- emails insensibles à la casse