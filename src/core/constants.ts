export const APP_NAME = 'dushu-notipay';
export const GITHUB_LINK = 'https://github.com/Naptie/dushu-notipay';

/** Default base URL of the Dushu Lake (慧湖通) API, used when config omits apiBaseUrl */
export const DEFAULT_API_BASE_URL = 'https://api.215123.cn';

/** Default number of retries for API calls, used when config omits billingRetryCount */
export const DEFAULT_API_RETRY_COUNT = 3;

/**
 * Marker prefix used by the API layer to signal that a failure is
 * authentication-related and must not be retried with the same token.
 */
export const NORETRY_ERROR_PREFIX = '[NORETRY]';

/** Parallel fetch batch size used by the hourly scheduler */
export const DATA_COLLECTION_BATCH_SIZE = 5;

/** The recharge team whose apartments are monitored (水电充值) */
export const RECHARGE_TEAM = '水电充值';

/**
 * The balance the API reports for a room when the caller is not
 * authenticated (or not registered to the room). Treated as "no data".
 */
export const BALANCE_MASK = '--';

export const DEFAULT_FETCH_INTERVAL = '1d';

/** Minimum balance change considered "spent" when reporting */
export const API_TIMEOUT_MS = 15_000;
