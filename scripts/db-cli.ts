#!/usr/bin/env node
/**
 * Database Management CLI
 * Usage: pnpm db-cli <command> [args]
 */

import { db, type RoomRegistration } from '../src/core/database.js';

const commands = {
  list: () => {
    const users = db.getAllUsers();
    console.log(`\nTotal users: ${users.length}\n`);
    console.log('ID\tQQ ID\t\tUser ID\t\tName\t\tInterval\tLast Fetch');
    console.log('─'.repeat(100));
    users.forEach((u) => {
      console.log(
        `${u.id}\t${u.qq_id}\t${u.user_id ?? 'N/A'}\t${u.name ?? 'N/A'}\t${u.fetch_interval}\t${u.last_login ?? 'Never'}`
      );
    });
    console.log();
  },

  count: () => {
    const count = db.getUserCount();
    console.log(`\nTotal users: ${count}\n`);
  },

  get: (qqId: string) => {
    if (!qqId) {
      console.error('Usage: get <qq_id>');
      return;
    }
    const user = db.getUser(qqId);
    if (user) {
      console.log('\nUser Information:');
      console.log(JSON.stringify(user, null, 2));
      console.log('\nRooms:');
      console.log(JSON.stringify(db.getRooms(qqId), null, 2));
      console.log();
    } else {
      console.log(`\nNo user found with QQ ID: ${qqId}\n`);
    }
  },

  openid: (qqId: string) => {
    if (!qqId) {
      console.error('Usage: openid <qq_id>');
      return;
    }
    const openId = db.getOpenId(qqId);
    if (openId) {
      console.log(`\nopenId: ${openId}\n`);
    } else {
      console.log(`\nNo user found with QQ ID: ${qqId}\n`);
    }
  },

  rooms: (qqId: string) => {
    if (!qqId) {
      console.error('Usage: rooms <qq_id>');
      return;
    }
    const rooms = db.getRooms(qqId);
    if (rooms.length > 0) {
      console.log('\nRooms:');
      rooms.forEach((room) => {
        const latest = db.getLatestBilling(qqId, room.room_uid);
        const balanceStr = latest
          ? `${latest.balance.toFixed(2)} 元 @ ${latest.recorded_at}`
          : 'no data';
        console.log(
          `  - ${room.room_label ?? room.room_uid} (${room.apartment_name ?? room.apartment_id}): ${balanceStr}`
        );
      });
      console.log();
    } else {
      console.log(`\nNo rooms bound for QQ ID: ${qqId}\n`);
    }
  },

  add: (qqId: string, openId: string, userId?: string, name?: string) => {
    if (!qqId || !openId) {
      console.error('Usage: add <qq_id> <openId> [user_id] [name]');
      return;
    }
    const user = db.addUser(qqId, openId, userId, name);
    console.log('\nUser added/updated:');
    console.log(JSON.stringify(user, null, 2));
    console.log();
  },

  bindRooms: (qqId: string, roomsJson: string) => {
    if (!qqId || !roomsJson) {
      console.error('Usage: bind-rooms <qq_id> <rooms_json>');
      console.error(
        'rooms_json: [{"apartmentId":"15","apartmentName":"文荟学生公寓(新)","roomUid":"...","roomLabel":"..."}]'
      );
      return;
    }
    const rooms = JSON.parse(roomsJson) as RoomRegistration[];
    db.replaceRooms(qqId, rooms);
    console.log(`\nBound ${rooms.length} room(s) to ${qqId}\n`);
  },

  delete: (qqId: string) => {
    if (!qqId) {
      console.error('Usage: delete <qq_id>');
      return;
    }
    const deleted = db.deleteUser(qqId);
    if (deleted) {
      console.log(`\nUser with QQ ID ${qqId} has been deleted.\n`);
    } else {
      console.log(`\nNo user found with QQ ID: ${qqId}\n`);
    }
  },

  history: (qqId: string, roomUid?: string, days?: string) => {
    if (!qqId) {
      console.error('Usage: history <qq_id> [room_uid] [days]');
      return;
    }
    const records = db.getBillingHistory(qqId, roomUid, days ? parseInt(days) : undefined);
    console.log(`\nBilling history (${records.length} records):\n`);
    records.forEach((record) => {
      console.log(
        `${record.recorded_at}\t${record.room_label ?? record.room_uid}\t${record.balance.toFixed(2)} 元`
      );
    });
    console.log();
  },

  backup: (path?: string) => {
    const backupPath = path || `data-backup-${Date.now()}.db`;
    db.backup(backupPath);
    console.log(`\nDatabase backed up to: ${backupPath}\n`);
  },

  help: () => {
    console.log(`
Database Management CLI

Commands:
  list                                    List all users
  count                                   Show total user count
  get <qq_id>                             Get user information and rooms
  openid <qq_id>                          Show the decrypted openId of a user
  rooms <qq_id>                           Show bound rooms and latest balances
  history <qq_id> [room_uid] [days]       Show billing history
  add <qq_id> <openId> [user_id] [name]   Add/update user
  bind-rooms <qq_id> <rooms_json>         Replace the rooms bound to a user
  delete <qq_id>                          Delete user
  backup [path]                           Backup database
  help                                    Show this help message

Examples:
  pnpm db-cli list
  pnpm db-cli get 123456789
  pnpm db-cli add 123456789 oXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX 2092417937299812353 "Zhang San"
  pnpm db-cli history 123456789 2069655907813929021 7
  pnpm db-cli delete 123456789
  pnpm db-cli backup ./backups/data.db
`);
  }
};

const [, , command, ...args] = process.argv;

if (!command || command === 'help' || !(command in commands)) {
  commands.help();
} else {
  try {
    const cmd = commands[command as keyof typeof commands] as (...args: string[]) => void;
    cmd(...args);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    db.close();
  }
}
