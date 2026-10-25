import type { NCWebsocket, SendMessageSegment } from 'node-napcat-ts';
import { getRoomBalance } from '../api/dushu.js';
import { withTokenRefresh } from '../core/auth.js';
import { db, scheduler, type UserPublic } from '../core/database.js';
import { DATA_COLLECTION_BATCH_SIZE, DAILY_UPDATE_HOUR } from '../core/constants.js';
import { lastDailySlot, formatLocalTimestamp, parseLocalTimestamp } from '../core/time.js';
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
 * One unit of work for the collector.
 *
 * `persist` decides whether the fetched balances are written to the billing
 * history. Only the daily update persists; notification runs fetch live
 * balances without touching the history, so the chart keeps exactly one point
 * per day. `recordedAt` pins the timestamp of the written row to the
 * scheduled daily slot.
 */
export interface CollectTask {
  user: UserPublic;
  persist: boolean;
  recordedAt?: string;
}

/**
 * Fetch fresh balances for every room bound to a user, recording each value
 * into the billing history. Handles token minting/refresh automatically.
 */
export const collectUserData = async (
  user: UserPublic,
  options: { persist?: boolean; recordedAt?: string } = {}
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
          db.addBillingHistory(
            user.qq_id,
            room.room_uid,
            balance,
            room.room_label ?? undefined,
            options.recordedAt
          );
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
      db.updateLastLogin(user.qq_id, options.recordedAt);
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
  tasks: CollectTask[],
  batchSize: number = DATA_COLLECTION_BATCH_SIZE
): Promise<CollectedData[]> => {
  const results: CollectedData[] = [];

  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    console.log(
      `[Scheduler] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(tasks.length / batchSize)} (${batch.length} users)`
    );

    const batchResults = await Promise.all(
      batch.map((task) =>
        collectUserData(task.user, { persist: task.persist, recordedAt: task.recordedAt })
      )
    );
    results.push(...batchResults);

    // Small delay between batches to avoid overwhelming the server
    if (i + batchSize < tasks.length) {
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
  scheduledHour: number,
  napcat: NCWebsocket
): Promise<void> => {
  if (!collected.success) {
    console.log(
      `[Scheduler] Skipping notifications for ${collected.name || collected.qqId} due to data collection failure`
    );
    return;
  }

  const notifications = scheduler.getNotificationsAtHourForUser(collected.qqId, scheduledHour);

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

/**
 * Decide whether the daily update is still pending for a user.
 *
 * The anchor is the moment of the user's last successful daily update, or the
 * moment they bound when they have never been updated. The update is due as
 * soon as a daily slot has been reached that the anchor does not cover yet.
 * This keeps one history point per day and catches up automatically when the
 * process was down at the daily slot.
 */
const isDailyUpdateDue = (user: UserPublic, slot: Date): boolean => {
  try {
    const anchor = parseLocalTimestamp(user.last_login ?? user.created_at);
    return anchor.getTime() < slot.getTime();
  } catch (error) {
    console.error(`[Scheduler] Error checking daily update for ${user.qq_id}:`, error);
    return false;
  }
};

/**
 * Run the hourly collection + notification cycle.
 *
 * `scheduledHour` is the hour of day (0-23) the tick was scheduled for. The
 * timer tracks it explicitly instead of deriving it from the wall clock, so a
 * tick that runs late cannot be attributed to the next hour.
 */
export const runHourlyTasks = async (napcat: NCWebsocket, scheduledHour: number): Promise<void> => {
  try {
    const now = new Date();
    console.log(`[Scheduler] Running for hour: ${scheduledHour}`);

    const allUsers = db.getAllUsers();
    console.log(`[Scheduler] Checking ${allUsers.length} users`);

    if (allUsers.length === 0) {
      console.log('[Scheduler] No users to process');
      return;
    }

    // The daily slot the readings belong to: the most recent one at or before
    // now. A run that happens late (e.g. after downtime) is still recorded on
    // the daily grid, and a reading taken before the daily hour closes the
    // previous day.
    const slot = lastDailySlot(now, DAILY_UPDATE_HOUR);

    const tasks: CollectTask[] = [];

    for (const user of allUsers) {
      const notifications = scheduler.getNotificationsAtHourForUser(user.qq_id, scheduledHour);
      const isDaily = isDailyUpdateDue(user, slot);

      if (!isDaily && notifications.length === 0) {
        continue;
      }

      console.log(
        isDaily
          ? `[Scheduler] Fetching for ${user.qq_id} due to daily update`
          : `[Scheduler] Fetching for ${user.qq_id} due to scheduled notification`
      );

      tasks.push({
        user,
        // Only the daily update writes history; notification runs report live
        // balances so the chart keeps exactly one point per day.
        persist: isDaily,
        recordedAt: isDaily ? formatLocalTimestamp(slot) : undefined
      });
    }

    if (tasks.length === 0) {
      console.log('[Scheduler] No users need fetching this hour');
      return;
    }

    console.log(`[Scheduler] Phase 1: Collecting data for ${tasks.length} users...`);
    const collectedData = await collectData(tasks);
    const successCount = collectedData.filter((d) => d.success).length;
    const failureCount = collectedData.length - successCount;
    console.log(
      `[Scheduler] Data collection complete: ${successCount} succeeded, ${failureCount} failed`
    );

    console.log('[Scheduler] Phase 2: Sending notifications...');
    for (const data of collectedData) {
      await sendNotificationForUser(data, scheduledHour, napcat);
    }

    console.log('[Scheduler] Hourly tasks completed');
  } catch (error) {
    console.error('[Scheduler] Error during hourly tasks:', error);
  }
};

let hourlyTimeout: NodeJS.Timeout | null = null;

/** Hour of day (0-23) the pending tick is scheduled for. */
let scheduledHour = 0;

/**
 * Milliseconds until the next top of the hour
 */
const msUntilNextHour = (now: Date): number => {
  const target = new Date(now);
  target.setHours(target.getHours() + 1, 0, 0, 0);
  return target.getTime() - now.getTime();
};

/**
 * Schedule the next tick for the upcoming top of the hour.
 *
 * The next tick is armed after the current one finished, so a slow run can
 * never make the timer drift across an hour boundary.
 */
const scheduleNextTick = (napcat: NCWebsocket): void => {
  const now = new Date();
  const delay = msUntilNextHour(now);
  scheduledHour = (now.getHours() + 1) % 24;
  const hour = scheduledHour;

  console.log(
    `[Scheduler] Next run at ${String(hour).padStart(2, '0')}:00 (in ${Math.round(delay / 1000 / 60)} minutes)`
  );

  hourlyTimeout = setTimeout(() => {
    void (async () => {
      await runHourlyTasks(napcat, hour);
      scheduleNextTick(napcat);
    })();
  }, delay);
};

/**
 * Start the hourly timer (runs on the hour, every hour)
 */
export const startHourlyTimer = (napcat: NCWebsocket): void => {
  stopHourlyTimer();

  const now = new Date();
  const delayUntilNextHour = msUntilNextHour(now);

  console.log(
    `[Scheduler] Will start in ${Math.round(delayUntilNextHour / 1000 / 60)} minutes (at next hour)`
  );

  scheduleNextTick(napcat);
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
};
