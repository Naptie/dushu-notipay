import type { NCWebsocket, SendMessageSegment } from 'node-napcat-ts';
import { getRoomBalance } from '../api/dushu.js';
import { withTokenRefresh } from '../core/auth.js';
import { db, scheduler, type UserPublic } from '../core/database.js';
import { DATA_COLLECTION_BATCH_SIZE, DEFAULT_FETCH_INTERVAL } from '../core/constants.js';
import { calculateNextFetchTime, parseRelativeTime } from '../core/time.js';
import { generateBalanceChart } from '../presentation/charts.js';
import { generateBalanceSummary } from '../presentation/summary.js';

export interface CollectedRoom {
  roomUid: string;
  roomLabel: string;
  balance: number;
}

export interface CollectedData {
  qqId: string;
  name: string | null | undefined;
  rooms: CollectedRoom[];
  success: boolean;
  error?: Error;
}

/**
 * Fetch fresh balances for every room bound to a user, recording each value
 * into the billing history. Handles token minting/refresh automatically.
 */
export const collectUserData = async (
  user: UserPublic,
  options: { persist?: boolean } = {}
): Promise<CollectedData> => {
  const persist = options.persist ?? true;
  const rooms = db.getRooms(user.qq_id);
  if (rooms.length === 0) {
    return {
      qqId: user.qq_id,
      name: user.name,
      rooms: [],
      success: false,
      error: new Error('未绑定任何房间')
    };
  }

  try {
    const collected = await withTokenRefresh(user.qq_id, async (token) => {
      const results: CollectedRoom[] = [];
      for (const room of rooms) {
        const balance = await getRoomBalance(token, room.apartment_id, room.room_uid);
        if (persist) {
          db.addBillingHistory(user.qq_id, room.room_uid, balance, room.room_label ?? undefined);
        }
        results.push({
          roomUid: room.room_uid,
          roomLabel: room.room_label ?? room.room_uid,
          balance
        });
      }
      return results;
    });

    if (persist) {
      db.updateLastLogin(user.qq_id);
    }
    console.log(
      `[Scheduler] Collected data for ${user.name || user.qq_id} (${collected.length} rooms)`
    );
    return { qqId: user.qq_id, name: user.name, rooms: collected, success: true };
  } catch (error) {
    console.error(`[Scheduler] Failed to collect data for QQ ${user.qq_id}:`, error);
    return {
      qqId: user.qq_id,
      name: user.name,
      rooms: [],
      success: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
};

/**
 * Collect users in parallel batches
 */
export const collectData = async (
  users: UserPublic[],
  batchSize: number = DATA_COLLECTION_BATCH_SIZE
): Promise<CollectedData[]> => {
  const results: CollectedData[] = [];

  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    console.log(
      `[Scheduler] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(users.length / batchSize)} (${batch.length} users)`
    );

    const batchResults = await Promise.all(
      batch.map((user) => collectUserData(user, { persist: true }))
    );
    results.push(...batchResults);

    // Small delay between batches to avoid overwhelming the server
    if (i + batchSize < users.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return results;
};

/**
 * Build the message segments (summary text + charts) for a user.
 */
const buildReportSegments = async (
  collected: CollectedData,
  historyDays: number
): Promise<SendMessageSegment[]> => {
  const views = collected.rooms.map((room) => ({
    roomLabel: room.roomLabel,
    balance: room.balance,
    change24h: db.getBalance24hChange(collected.qqId, room.roomUid)?.balance ?? null
  }));

  const segments: SendMessageSegment[] = [
    { type: 'text', data: { text: generateBalanceSummary(views) } }
  ];

  let chartCount = 0;

  for (const room of collected.rooms) {
    const history = db
      .getBillingHistory(collected.qqId, room.roomUid, historyDays)
      .reverse()
      .map((record) => ({ timestamp: record.recorded_at, balance: record.balance }));

    const charts = await generateBalanceChart(history, room.roomLabel);
    for (const chart of charts) {
      segments.push({
        type: 'image',
        data: { file: `base64://${chart.buffer.toString('base64')}` }
      });
      chartCount++;
    }
  }

  if (chartCount === 0 && collected.rooms.length > 0) {
    segments[0].data.text += '\n💡 需要至少 2 条历史记录才能显示趋势图';
  }

  return segments;
};

/**
 * Send scheduled notifications for a user based on collected data
 */
export const sendNotificationForUser = async (
  collected: CollectedData,
  currentHour: number,
  napcat: NCWebsocket
): Promise<void> => {
  if (!collected.success) {
    console.log(
      `[Scheduler] Skipping notifications for ${collected.name || collected.qqId} due to data collection failure`
    );
    return;
  }

  const notifications = scheduler.getNotificationsAtHourForUser(collected.qqId, currentHour);

  for (const notification of notifications) {
    try {
      // Check if threshold is set and if any balance is below it
      let shouldSendNotification = true;

      if (notification.threshold !== null && notification.threshold !== undefined) {
        const threshold = notification.threshold;
        shouldSendNotification = collected.rooms.some((room) => room.balance < threshold);

        if (!shouldSendNotification) {
          continue;
        }
      }

      console.log(`[Scheduler] Sending notification to ${collected.name || collected.qqId}`);

      const segments = await buildReportSegments(collected, 7);

      if (notification.chat_type && notification.chat_id) {
        if (notification.chat_type === 'private') {
          await napcat.send_private_msg({
            user_id: parseInt(notification.chat_id),
            message: segments
          });
        } else {
          await napcat.send_group_msg({
            group_id: parseInt(notification.chat_id),
            message: segments
          });
        }
        console.log(
          `[Scheduler] Sent notification to ${notification.chat_type} ${notification.chat_id}`
        );
      }
    } catch (error) {
      console.error(
        `[Scheduler] Failed to send notification for QQ ${collected.qqId} to ${notification.chat_type} ${notification.chat_id}:`,
        error
      );
    }
  }
};

const isFetchDue = (user: UserPublic, now: Date): boolean => {
  try {
    const intervalHours = parseRelativeTime(user.fetch_interval || DEFAULT_FETCH_INTERVAL);
    const nextFetchTime = calculateNextFetchTime(
      user.last_login ?? undefined,
      user.created_at,
      intervalHours
    );

    // Check if current time is at or after the scheduled fetch time
    // We use a small buffer (5 mins) to handle slight timing differences
    return now.getTime() >= nextFetchTime.getTime() - 5 * 60 * 1000;
  } catch (error) {
    console.error(`[Scheduler] Error checking interval for ${user.qq_id}:`, error);
    return false;
  }
};

/**
 * Run the hourly collection + notification cycle
 */
export const runHourlyTasks = async (napcat: NCWebsocket): Promise<void> => {
  try {
    const now = new Date();
    const currentHour = now.getMinutes() >= 30 ? (now.getHours() + 1) % 24 : now.getHours();
    console.log(`[Scheduler] Running for hour: ${currentHour}`);

    const allUsers = db.getAllUsers();
    console.log(`[Scheduler] Checking ${allUsers.length} users`);

    if (allUsers.length === 0) {
      console.log('[Scheduler] No users to process');
      return;
    }

    const usersToFetch: UserPublic[] = [];

    for (const user of allUsers) {
      let shouldFetch = false;

      // (a) scheduled notification due at this hour
      const notifications = scheduler.getNotificationsAtHourForUser(user.qq_id, currentHour);
      if (notifications.length > 0) {
        shouldFetch = true;
        console.log(`[Scheduler] Fetching for ${user.qq_id} due to scheduled notification`);
      }

      // (b) fetch interval elapsed
      if (!shouldFetch && isFetchDue(user, now)) {
        shouldFetch = true;
        console.log(
          `[Scheduler] Fetching for ${user.qq_id} due to interval (${user.fetch_interval})`
        );
      }

      if (shouldFetch) {
        usersToFetch.push(user);
      }
    }

    if (usersToFetch.length === 0) {
      console.log('[Scheduler] No users need fetching this hour');
      return;
    }

    console.log(`[Scheduler] Phase 1: Collecting data for ${usersToFetch.length} users...`);
    const collectedData = await collectData(usersToFetch);
    const successCount = collectedData.filter((d) => d.success).length;
    const failureCount = collectedData.length - successCount;
    console.log(
      `[Scheduler] Data collection complete: ${successCount} succeeded, ${failureCount} failed`
    );

    console.log('[Scheduler] Phase 2: Sending notifications...');
    for (const data of collectedData) {
      await sendNotificationForUser(data, currentHour, napcat);
    }

    console.log('[Scheduler] Hourly tasks completed');
  } catch (error) {
    console.error('[Scheduler] Error during hourly tasks:', error);
  }
};

let hourlyTimeout: NodeJS.Timeout | null = null;
let hourlyInterval: NodeJS.Timeout | null = null;

/**
 * Start the hourly timer (runs on the hour, every hour)
 */
export const startHourlyTimer = (napcat: NCWebsocket): void => {
  stopHourlyTimer();

  const now = new Date();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const milliseconds = now.getMilliseconds();

  const delayUntilNextHour = (60 - minutes - 1) * 60 * 1000 + (60 - seconds) * 1000 - milliseconds;

  console.log(
    `[Scheduler] Will start in ${Math.round(delayUntilNextHour / 1000 / 60)} minutes (at next hour)`
  );

  hourlyTimeout = setTimeout(() => {
    runHourlyTasks(napcat);

    hourlyInterval = setInterval(() => runHourlyTasks(napcat), 60 * 60 * 1000);
    hourlyTimeout = null;
    console.log('[Scheduler] Timer started (runs every hour on the hour)');
  }, delayUntilNextHour);
};

/**
 * Stop the hourly timer
 */
export const stopHourlyTimer = (): void => {
  if (hourlyTimeout) {
    clearTimeout(hourlyTimeout);
    hourlyTimeout = null;
    console.log('[Scheduler] Pending timer cleared');
  }
  if (hourlyInterval) {
    clearInterval(hourlyInterval);
    hourlyInterval = null;
    console.log('[Scheduler] Timer stopped');
  }
};
