import { certificateLogin, getRegisteredRooms, AuthError } from '../api/dushu.js';
import { db } from './database.js';

export { AuthError } from '../api/dushu.js';
export type { LoginResult, LoginIdentity, Apartment, RegisteredRoom } from '../api/dushu.js';

/**
 * Mint a fresh token for a user and store it.
 */
export const mintAndStoreToken = async (qqId: string): Promise<string> => {
  const openId = db.getOpenId(qqId);
  if (!openId) {
    throw new AuthError('未绑定账号');
  }

  const result = await certificateLogin(openId);
  db.setToken(qqId, result.token);
  return result.token;
};

/**
 * Get a usable token for a user: the cached one if present, otherwise a
 * freshly minted one.
 */
export const getUserToken = async (qqId: string): Promise<string> => {
  const cached = db.getToken(qqId);
  if (cached) {
    return cached;
  }
  return mintAndStoreToken(qqId);
};

/**
 * Run an API call with automatic token management: use the cached token and,
 * when the API rejects it, mint a fresh one and retry exactly once.
 */
export const withTokenRefresh = async <T>(
  qqId: string,
  fn: (token: string) => Promise<T>
): Promise<T> => {
  try {
    const token = await getUserToken(qqId);
    return await fn(token);
  } catch (error) {
    if (error instanceof AuthError) {
      db.clearToken(qqId);
      const token = await mintAndStoreToken(qqId);
      return await fn(token);
    }
    throw error;
  }
};

/**
 * Validate an openId by minting a token and listing the registered rooms.
 * Used by the bind flow.
 */
export const validateOpenId = async (openId: string) => {
  const identity = await certificateLogin(openId);
  const rooms = await getRegisteredRooms(identity.token);
  return { identity, rooms };
};
