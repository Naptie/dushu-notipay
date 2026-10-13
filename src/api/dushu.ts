import {
  BALANCE_MASK,
  DEFAULT_API_BASE_URL,
  DEFAULT_API_RETRY_COUNT,
  NORETRY_ERROR_PREFIX,
  RECHARGE_TEAM
} from '../core/constants.js';
import { fetch } from '../core/fetch.js';

/**
 * Error thrown when the API rejects or effectively ignores the provided
 * token. Callers should re-mint a token and retry once.
 */
export class AuthError extends Error {}

/**
 * Error thrown when the API replies with a non-success envelope or an
 * unexpected payload.
 */
export class ApiError extends Error {}

interface Envelope<T> {
  success: boolean;
  message: string;
  code: number;
  result?: T;
  data?: T;
  timestamp: number | string | null;
  requestId?: string | null;
}

interface ApiOptions {
  token?: string;
  query?: Record<string, string>;
  retryCount?: number;
}

// Runtime-configurable settings; defaults keep this module usable standalone.
let apiBaseUrl = DEFAULT_API_BASE_URL;
let defaultRetryCount = DEFAULT_API_RETRY_COUNT;

/**
 * Configure the API client. Called once at application startup with values
 * from config.json (single source of truth for runtime configuration).
 */
export const configureApi = (options: { baseUrl?: string; retryCount?: number }): void => {
  if (options.baseUrl) {
    apiBaseUrl = options.baseUrl.replace(/\/+$/, '');
  }
  if (options.retryCount !== undefined) {
    defaultRetryCount = options.retryCount;
  }
};

const authErrorMessage = (message: string): boolean =>
  /认证失败|token (无效|已过期)|NotLogin/i.test(message);

/**
 * Perform a GET request against the Dushu Lake API and unwrap the envelope.
 * Retries transient failures, marks authentication failures as non-retriable.
 */
const apiGet = async <T>(path: string, options: ApiOptions = {}): Promise<T> => {
  const retryCount = options.retryCount ?? defaultRetryCount;

  const url = new URL(path, apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options.token ? { satoken: options.token } : {})
        }
      });

      if (!response.ok) {
        const nonRetry = response.status === 401 ? NORETRY_ERROR_PREFIX : '';
        throw new Error(`${nonRetry}HTTP ${response.status}: ${response.statusText}`);
      }

      const envelope = (await response.json()) as Envelope<T>;

      if (!envelope.success || envelope.code !== 200) {
        const nonRetry = authErrorMessage(envelope.message) ? NORETRY_ERROR_PREFIX : '';
        throw new Error(`${nonRetry}API Error ${envelope.code}: ${envelope.message}`);
      }

      return (envelope.result !== undefined ? envelope.result : envelope.data) as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.message.startsWith(NORETRY_ERROR_PREFIX)) {
        throw new AuthError(lastError.message.replace(NORETRY_ERROR_PREFIX, ''));
      }

      if (attempt < retryCount) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error(`Failed to fetch ${path} after all retries`);
};

export interface LoginIdentity {
  userId: string;
  account: string | null;
  name: string | null;
}

export interface LoginResult extends LoginIdentity {
  token: string;
}

/**
 * Exchange a WeChat openId for a fresh satoken (and the account identity).
 *
 * Note: minting a token invalidates the previous token of the same account,
 * including the one held by the user's own mini program session — the mini
 * program will silently re-authenticate on its next launch/login flow.
 */
export const certificateLogin = async (openId: string): Promise<LoginResult> => {
  const data = await apiGet<{
    userId: string;
    account: string | null;
    name: string | null;
    tokenName: string;
    token: string;
  }>('/web-app/auth/certificateLogin', { query: { openId }, retryCount: 1 });

  if (!data?.token) {
    throw new ApiError('certificateLogin 未返回 token，openId 可能无效');
  }

  return {
    token: data.token,
    userId: data.userId,
    account: data.account ?? null,
    name: data.name ?? null
  };
};

/**
 * Fetch the account profile behind a token (used to validate tokens).
 */
export const getLoginInfo = async (token: string): Promise<LoginIdentity> => {
  const data = await apiGet<{ id: string; account: string | null; name: string | null }>(
    '/pms/welcome/login-info',
    { token, retryCount: 0 }
  );

  if (!data?.id) {
    throw new ApiError('login-info 未返回用户信息');
  }

  return { userId: data.id, account: data.account ?? null, name: data.name ?? null };
};

export interface Apartment {
  id: string;
  title: string;
  /** The apartmentId used by the balance API (the `param` field) */
  apartmentId: string;
}

/**
 * List all apartments of the 水电充值 team.
 */
export const getApartments = async (token: string): Promise<Apartment[]> => {
  const result = await apiGet<Array<{ id: string; title: string; param: string; team: string }>>(
    '/proxy/qy/sdcz/queryByTeam',
    { token, query: { team: RECHARGE_TEAM } }
  );

  if (!Array.isArray(result)) {
    throw new ApiError('queryByTeam 返回格式异常');
  }

  return result
    .filter((item) => item.param)
    .map((item) => ({ id: item.id, title: item.title, apartmentId: item.param }));
};

interface DefaultRoomRecord {
  id: string;
  gongyu: string;
  loudong: string;
  louceng: string;
  room: string;
  isDelete: number;
}

export interface RegisteredRoom {
  apartmentId: string;
  apartmentName: string;
  roomUid: string;
  roomLabel: string;
}

/**
 * Fetch the rooms registered to the authenticated user.
 *
 * Note: the API ignores the areaId filter and always returns the caller's
 * registered rooms, so any apartmentId works as the argument.
 */
export const getDefaultRooms = async (
  token: string,
  apartmentId: string
): Promise<RegisteredRoom[]> => {
  const result = await apiGet<Record<string, DefaultRoomRecord[]>>('/proxy/qy/sdcz/getDefault', {
    token,
    query: { areaId: apartmentId },
    retryCount: 1
  });

  if (!result || typeof result !== 'object') {
    return [];
  }

  const records = Object.values(result).flat();
  return records
    .filter((record) => record && record.id && record.isDelete === 0)
    .map((record) => ({
      apartmentId,
      apartmentName: record.gongyu,
      roomUid: record.id,
      roomLabel: `${record.gongyu}${record.loudong}${record.louceng}${record.room}`
    }));
};

/**
 * Fetch the rooms registered to the authenticated user, resolving each
 * room's apartmentId.
 *
 * Two API quirks make this necessary:
 * - `getDefault` ignores its areaId filter and always returns the caller's
 *   registered rooms, so the apartment cannot be derived from it;
 * - `getRoomBalance` only returns a number when the apartmentId matches the
 *   room's actual apartment (otherwise it returns null).
 *
 * We therefore probe the balance API once per candidate apartment per room
 * (bind-time only) to find the apartmentId that accepts the room.
 */
export const getRegisteredRooms = async (token: string): Promise<RegisteredRoom[]> => {
  const apartments = await getApartments(token);
  if (apartments.length === 0) {
    return [];
  }

  const records = await getDefaultRooms(token, apartments[0].apartmentId);

  const resolved: RegisteredRoom[] = [];
  for (const record of records) {
    const apartmentId = await resolveRoomApartmentId(token, record.roomUid, apartments);
    if (apartmentId === null) {
      console.warn(`[API] 无法确定房间 ${record.roomLabel} 所属公寓，已跳过`);
      continue;
    }
    resolved.push({ ...record, apartmentId });
  }
  return resolved;
};

/**
 * Find the apartmentId under which the balance API accepts a room.
 * Returns null when no apartment accepts it.
 */
const resolveRoomApartmentId = async (
  token: string,
  roomUid: string,
  apartments: Apartment[]
): Promise<string | null> => {
  for (const apartment of apartments) {
    try {
      await getRoomBalance(token, apartment.apartmentId, roomUid);
      return apartment.apartmentId;
    } catch (error) {
      if (error instanceof AuthError) {
        throw error; // token problem — not an apartment mismatch
      }
      // ApiError (null result / unexpected payload) → try the next apartment
    }
  }
  return null;
};

/**
 * Fetch the balance of one room.
 *
 * The API answers 200 with the literal mask "--" when the token is not
 * accepted; that case is surfaced as an AuthError so callers can re-mint.
 */
export const getRoomBalance = async (
  token: string,
  apartmentId: string,
  roomUid: string
): Promise<number> => {
  const result = await apiGet<number | string>('/proxy/qy/sdcz/getRoomBalance', {
    token,
    query: { apartmentId, roomId: roomUid },
    retryCount: 1
  });

  if (typeof result === 'string') {
    if (result.trim() === BALANCE_MASK) {
      throw new AuthError(`房间 ${roomUid} 余额被掩码（token 未被接受）`);
    }
    throw new ApiError(`房间 ${roomUid} 余额返回异常：${result}`);
  }

  if (typeof result !== 'number' || Number.isNaN(result)) {
    throw new ApiError(`房间 ${roomUid} 余额返回格式异常：${JSON.stringify(result)}`);
  }

  return result;
};
