// Identite placee par JwtAuthGuard dans req.user
export interface AuthUser {
  id: number;
  role: string;
}

export type AuthedRequest = { user: AuthUser };
