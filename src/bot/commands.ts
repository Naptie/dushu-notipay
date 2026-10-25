import type { NCWebsocket, SendMessageSegment } from 'node-napcat-ts';
import { validateOpenId, AuthError } from '../core/auth.js';
import { db, scheduler } from '../core/database.js';
import { APP_NAME, DAILY_UPDATE_HOUR, GITHUB_LINK } from '../core/constants.js';
import { formatLocalShort, nextDailyUpdate, parseTimeParameter } from '../core/time.js';
import { generateBalanceChart } from '../presentation/charts.js';
import { generateBalanceSummary } from '../presentation/summary.js';
import { collectUserData } from './tasks.js';

export interface CommandContext {
  command: string;
  params: string[];
  qqId: string;
  isPrivateChat: boolean;
  chatId: string;
  napcat: NCWebsocket;
  send: (message: string | SendMessageSegment[]) => Promise<void>;
}

/** WeChat openIds are 28 chars and start with "o" */
const OPENID_PATTERN = /^o[a-zA-Z0-9_-]{27}$/;

const BIND_GUIDE = (command: string): string =>
  [
    '🔐 绑定前，你需要先找到自己的账号 ID（openId）。',
    '',
    '需用一台 Windows 10/11 x64 电脑，并登录 Windows 微信 4.x。',
    '1. 按 Win+R，粘贴并运行：',
    '   powershell -NoProfile -c "iex (irm https://raw.githubusercontent.com/Naptie/wxmp-storage-dumper/main/scripts/install.ps1)"',
    '   如遇到网络问题，请运行：',
    '   powershell -NoProfile -c "iex (irm https://gitee.com/naptie/wxmp-storage-dumper/raw/main/scripts/install.ps1)"',
    '2. 按提示在微信中打开「慧湖通」（若已打开，请先完全关闭再重新打开）。',
    '3. 确认输出 appId 为 wx2660b404a3b7575a，复制 openId。',
    `4. 私聊发送：${command} bind <openId>。`,
    '',
    '注：openId 是账号凭证，请只通过 Bot 私聊发送，不要公开分享。'
  ].join('\n');

const handleHelp = async ({ command, send }: CommandContext): Promise<void> => {
  let commitHash = 'unknown';
  try {
    const { execSync } = await import('child_process');
    commitHash = execSync('git rev-parse HEAD').toString().trim().slice(0, 7);
  } catch {
    // not a git checkout
  }

  const message =
    `[${APP_NAME}] 可用命令：\n\n` +
    '1. 绑定账号（仅限私聊）：\n' +
    `${command} bind\n` +
    `   查看如何找到自己的 openId（账号 ID）。\n` +
    `${command} bind <openId>\n` +
    `   例：${command} bind oX7-abC123...(28 位，以 o 开头)\n\n` +
    '2. 解绑账号：\n' +
    `${command} unbind\n\n` +
    '3. 查看已绑定房间及最新余额：\n' +
    `${command} rooms\n\n` +
    '4. 查询当前账单：\n' +
    `${command} query [起始时间] [结束时间]\n` +
    '   或\n' +
    `${command} bills [起始时间] [结束时间]\n` +
    '   时间格式支持：\n' +
    '   - 相对时间：7h（7 小时前），3d（3 天前），2w（2 周前）\n' +
    '   - 绝对时间：1030（10 月 30 日 0:00），10302330（10 月 30 日 23:30）\n' +
    '   - 带分隔符：10-30|23:30，10/30|23:30\n' +
    `   例：${command} query 7d（显示最近 7 天；默认）\n\n` +
    '5. 查询定时通知：\n' +
    `${command} notify list\n\n` +
    '6. 设置定时通知：\n' +
    `${command} notify <小时 (0-23)> [阈值]\n` +
    `   例：${command} notify 20 10\n` +
    '   每天晚上 8 点，当任一房间余额低于 10 元时发送账单报告。\n' +
    '   不设阈值则每天该时间必定发送。\n\n' +
    '7. 取消定时通知：\n' +
    `${command} unnotify\n\n` +
    `账单历史每天 ${DAILY_UPDATE_HOUR}:00 自动更新一次。\n\n` +
    '尖括号 <> 表示必填参数，中括号 [] 表示可选参数。\n' +
    '如有其他疑问，请联系管理员。\n' +
    `当前 commit：${commitHash}\n` +
    `GitHub 仓库：${GITHUB_LINK}`;
  await send([{ type: 'node', data: { content: [{ type: 'text', data: { text: message } }] } }]);
};

const handleBind = async ({
  command,
  params,
  qqId,
  isPrivateChat,
  send
}: CommandContext): Promise<void> => {
  if (!isPrivateChat) {
    await send('为保护账号信息安全，该功能仅限私聊使用。');
    return;
  }

  if (params.length === 0) {
    await send(BIND_GUIDE(command));
    return;
  }

  if (params.length > 1) {
    await send(`用法：${command} bind <openId>`);
    return;
  }

  const openId = params[0];
  if (!OPENID_PATTERN.test(openId)) {
    await send(
      'openId 格式不正确（应为 28 位、以 o 开头的字符串）。\n' +
        `如不确定，请发送 ${command} bind 查看获取方法。`
    );
    return;
  }

  console.log(`[Bind] QQ: ${qqId}, openId: ${openId.slice(0, 6)}...`);

  let identity;
  let rooms;
  try {
    ({ identity, rooms } = await validateOpenId(openId));
  } catch (error) {
    if (error instanceof AuthError || (error instanceof Error && error.message.includes('token'))) {
      await send('登录失败，请检查 openId 是否正确。');
    } else {
      await send(`验证账号时出错：${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  if (rooms.length === 0) {
    await send(
      '该账号下没有找到任何登记房间。\n' +
        '「慧湖通」仅支持查询本人登记的房间；如房间信息有误，请至公寓区一站式服务中心处理。'
    );
    return;
  }

  db.addUser(qqId, openId, identity.userId, identity.name ?? undefined);
  // Reuse the token minted during validation
  db.setToken(qqId, identity.token);
  db.replaceRooms(
    qqId,
    rooms.map((room) => ({
      apartmentId: room.apartmentId,
      apartmentName: room.apartmentName,
      roomUid: room.roomUid,
      roomLabel: room.roomLabel
    }))
  );
  console.log(
    `[DB] Stored credentials and ${rooms.length} room(s) for ${identity.name || identity.userId}`
  );

  const roomLines = rooms.map((room) => `- ${room.roomLabel}`).join('\n');
  let message = `成功绑定到 ${identity.name || identity.userId}，共 ${rooms.length} 个房间：\n${roomLines}`;

  const nextUpdate = nextDailyUpdate(new Date(), DAILY_UPDATE_HOUR);
  message += `\n账单历史每天 ${DAILY_UPDATE_HOUR}:00 自动更新，下次更新：${formatLocalShort(nextUpdate)}。`;

  await send(message);
};

const handleUnbind = async ({ qqId, send }: CommandContext): Promise<void> => {
  const notifications = scheduler.getNotificationsForUser(qqId);
  for (const notification of notifications) {
    scheduler.deleteNotification(notification.chat_type, notification.chat_id, qqId);
  }

  const deleted = db.deleteUser(qqId);
  if (deleted) {
    await send('已解除绑定。');
  } else {
    await send('您还未绑定账号。');
  }
};

const handleRooms = async ({ qqId, send }: CommandContext): Promise<void> => {
  const user = db.getUser(qqId);
  if (!user) {
    await send('您还未绑定账号。');
    return;
  }

  const rooms = db.getRooms(qqId);
  if (rooms.length === 0) {
    await send('您还未绑定任何房间。');
    return;
  }

  const lines = rooms.map((room) => {
    const latest = db.getLatestBilling(qqId, room.room_uid);
    const balanceStr = latest
      ? `${latest.balance.toFixed(2)} 元（${latest.recorded_at}）`
      : '暂无记录';
    return `- ${room.room_label ?? room.room_uid}：${balanceStr}`;
  });

  await send(`已绑定的房间：\n${lines.join('\n')}`);
};

const handleQuery = async ({ command, params, qqId, send }: CommandContext): Promise<void> => {
  const user = db.getUser(qqId);
  if (!user) {
    await send(`您还未绑定账号。请私聊发送：${command} bind 查看绑定方法。`);
    return;
  }

  let startTime: Date | null = null;
  let endTime: Date | null = null;

  try {
    if (params.length >= 1) {
      startTime = parseTimeParameter(params[0]);
    }
    if (params.length >= 2) {
      endTime = parseTimeParameter(params[1]);
    }

    if (startTime && endTime && startTime >= endTime) {
      await send('错误：起始时间必须早于结束时间。');
      return;
    }
  } catch (error) {
    await send(`时间参数格式错误：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // Fetch fresh balances without changing scheduled history or fetch timing.
  const collected = await collectUserData(user, { persist: false });
  if (!collected.success) {
    await send(`查询失败：${collected.error?.message ?? '未知错误'}`);
    return;
  }

  const views = collected.rooms.map((room) => ({
    roomLabel: room.roomLabel,
    balance: room.balance,
    change24h: db.getBalance24hChange(qqId, room.roomUid)?.balance ?? null
  }));

  const segments: SendMessageSegment[] = [
    { type: 'text', data: { text: generateBalanceSummary(views) } }
  ];

  let chartCount = 0;
  for (const room of db.getRooms(qqId)) {
    const history = db
      .getBillingHistoryByTimeRange(qqId, startTime, endTime)
      .filter((record) => record.room_uid === room.room_uid)
      .reverse()
      .map((record) => ({ timestamp: record.recorded_at, balance: record.balance }));

    const charts = await generateBalanceChart(history, room.room_label ?? room.room_uid);
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

  await send(segments);
};

const handleNotify = async ({
  command,
  params,
  qqId,
  isPrivateChat,
  chatId,
  napcat,
  send
}: CommandContext): Promise<void> => {
  if (params.length < 1 || params.length > 2) {
    await send(
      `查询定时通知：${command} notify list\n` +
        `设置定时通知：${command} notify <小时 (0-23)> [阈值]`
    );
    return;
  }

  if (params[0] === 'list') {
    const notifications = scheduler.getNotificationsForUser(qqId);
    if (notifications.length === 0) {
      await send('您还未设置定时通知。');
      return;
    }

    notifications.sort((a, b) => a.hour - b.hour);

    let message = '目前设置的定时通知：';
    for (const notification of notifications) {
      let chatName = '私聊';
      if (notification.chat_type === 'group') {
        try {
          const info = await napcat.get_group_info({ group_id: parseInt(notification.chat_id) });
          chatName = info.group_name;
        } catch {
          chatName = `群 ${notification.chat_id}`;
        }
      }
      message += `\n- ${notification.hour.toString().padStart(2, '0')}:00 ${chatName}`;
      if (notification.threshold !== null && notification.threshold !== undefined) {
        message += ` [${notification.threshold} 元]`;
      }
    }
    await send(message);
    return;
  }

  const hour = parseInt(params[0]);
  if (isNaN(hour) || hour < 0 || hour > 23) {
    await send('小时必须是 0 到 23 之间的数字。');
    return;
  }

  let threshold: number | undefined;
  if (params.length === 2) {
    const val = parseFloat(params[1]);
    if (isNaN(val) || val < 0) {
      await send('参数格式错误。阈值必须是非负数字。');
      return;
    }
    threshold = val;
  }

  if (!db.getUser(qqId)) {
    await send(`您还未绑定账号。请私聊发送：${command} bind 查看绑定方法。`);
    return;
  }

  scheduler.setNotification(isPrivateChat ? 'private' : 'group', chatId, qqId, hour, threshold);

  let message = `已设置每日 ${hour} 时在此${isPrivateChat ? '私聊' : '群聊'}`;
  if (threshold !== undefined) {
    message += `，当任一房间余额低于 ${threshold} 元时`;
  }
  message += '发送账单报告。';

  await send(message);
  console.log(
    `[Notify] Set notification for ${isPrivateChat ? 'private' : 'group'} ${chatId}, QQ ${qqId}, hour ${hour}, threshold ${threshold ?? 'none'}`
  );
};

const handleUnnotify = async ({
  qqId,
  isPrivateChat,
  chatId,
  send
}: CommandContext): Promise<void> => {
  const deleted = scheduler.deleteNotification(isPrivateChat ? 'private' : 'group', chatId, qqId);
  if (deleted) {
    await send('已取消定时通知。');
  } else {
    await send('您还未设置定时通知。');
  }
};

/**
 * Route a parsed command to its handler.
 * Unknown subcommands fall back to the help text.
 */
export const dispatchCommand = async (ctx: CommandContext): Promise<void> => {
  const [subcommand, ...params] = ctx.params;
  switch (subcommand) {
    case 'bind':
      await handleBind({ ...ctx, params });
      break;
    case 'unbind':
      await handleUnbind(ctx);
      break;
    case 'rooms':
      await handleRooms(ctx);
      break;
    case 'query':
    case 'bills':
      await handleQuery({ ...ctx, params });
      break;
    case 'notify':
      await handleNotify({ ...ctx, params });
      break;
    case 'unnotify':
      await handleUnnotify(ctx);
      break;
    case 'help':
      await handleHelp(ctx);
      break;
    default:
      await handleHelp(ctx);
      break;
  }
};
