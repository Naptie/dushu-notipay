import { NCWebsocket } from 'node-napcat-ts';
import type { AllHandlers, SendMessageSegment } from 'node-napcat-ts';
import { configureApi } from './api/dushu.js';
import { config } from './core/config.js';
import { APP_NAME } from './core/constants.js';
import { db } from './core/database.js';
import { dispatchCommand } from './bot/commands.js';
import { startHourlyTimer, stopHourlyTimer } from './bot/tasks.js';

// Wire runtime configuration into the API client (single source: config.json)
configureApi({ baseUrl: config.apiBaseUrl, retryCount: config.billingRetryCount });

const napcat = new NCWebsocket(
  {
    baseUrl: config.napcatWs,
    accessToken: config.napcatToken,
    reconnection: {
      enable: true,
      attempts: 10,
      delay: 5000
    }
  },
  false
);

// Small generic signallable promise: call `signal()` to resolve the promise.
const createSignallable = <T>() => {
  let resolver: (value: T) => void = () => undefined as unknown as void;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    signal(value: T) {
      resolver(value);
    }
  } as { promise: Promise<T>; signal: (value: T) => void };
};

const socketClose = createSignallable<void>();

napcat.on('socket.open', () => {
  console.log('[NapCat] Connected.');
  startHourlyTimer(napcat);
});

napcat.on('socket.close', () => {
  console.log('[NapCat] Disconnected.');
  try {
    socketClose.signal(undefined);
  } catch {
    // ignore if already resolved
  }
});

const parseMessage = (context: AllHandlers['message']) => {
  const message = context.message.find((m) => m.type === 'text');
  if (!message) return { command: null, args: null };
  const text = message.data.text;
  const segments = text
    .split(/\s+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!segments.length) return { command: null, args: null };
  const command = segments[0];
  if (!config.commandNames.includes(command)) return { command: null, args: null };
  return { command, args: segments.slice(1) };
};

napcat.on('message', async (context: AllHandlers['message']) => {
  const isPrivateChat = context.message_type === 'private';
  const send = async (message: string | SendMessageSegment[]) => {
    await (isPrivateChat
      ? napcat.send_private_msg({
          user_id: context.sender.user_id,
          message:
            typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : message
        })
      : napcat.send_group_msg({
          group_id: context.group_id,
          message:
            typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : message
        }));
  };

  try {
    const { command, args } = parseMessage(context);
    if (!command) return;
    if (!args || args.length === 0) {
      // Bare command name: show the help text
      await dispatchCommand({
        command,
        params: ['help'],
        qqId: context.sender.user_id.toString(),
        isPrivateChat,
        chatId: (isPrivateChat ? context.sender.user_id : context.group_id).toString(),
        napcat,
        send
      });
      return;
    }
    const qqId = context.sender.user_id.toString();
    const chatId = (isPrivateChat ? context.sender.user_id : context.group_id).toString();

    await dispatchCommand({
      command,
      params: args,
      qqId,
      isPrivateChat,
      chatId,
      napcat,
      send
    });
  } catch (error) {
    console.error(`[${APP_NAME}] Error handling message:`, error);
    await send('操作失败，请稍后重试。').catch(() => undefined);
  }
});

await napcat.connect();

let shutdownInitiated = false;
process.on('SIGINT', async () => {
  if (shutdownInitiated) {
    console.log('\nForce exiting...');
    process.exit(1);
  }
  shutdownInitiated = true;
  console.log('\nGracefully shutting down...');

  stopHourlyTimer();

  napcat.disconnect();

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
  await Promise.race([socketClose.promise, timeout]);

  db.close();
  console.log('[SQLite] Database closed.');

  console.log('Process exited.');
  process.exit(0);
});
