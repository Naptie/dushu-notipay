import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { encryptionService } from './encryption.js';
import { NotificationScheduler } from './scheduler.js';
import { DEFAULT_FETCH_INTERVAL } from './constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database path - stored in project root
const DB_PATH = path.join(__dirname, '..', '..', 'data.db');

export interface UserPublic {
  id: number;
  qq_id: string;
  user_id: string | null;
  name: string | null;
  fetch_interval: string;
  created_at: string;
  updated_at: string;
  last_login: string | null;
}

export interface BoundRoom {
  id: number;
  qq_id: string;
  apartment_id: string;
  apartment_name: string | null;
  room_uid: string;
  room_label: string | null;
}

export interface RoomRegistration {
  apartmentId: string;
  apartmentName: string;
  roomUid: string;
  roomLabel: string;
}

export interface BillingRecord {
  id: number;
  qq_id: string;
  room_uid: string;
  balance: number;
  room_label: string | null;
  recorded_at: string;
}

export interface BalanceChange {
  balance: number;
}

class UserDatabase {
  private db: Database.Database;

  constructor(dbPath: string = DB_PATH) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL'); // Better concurrency
    this.db.pragma('foreign_keys = ON');
    this.initializeDatabase();
  }

  /**
   * Initialize the database schema
   */
  private initializeDatabase(): void {
    const createUsersTableSQL = `
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        qq_id TEXT NOT NULL UNIQUE,
        encrypted_openid TEXT NOT NULL,
        salt TEXT NOT NULL,
        user_id TEXT,
        name TEXT,
        fetch_interval TEXT DEFAULT '${DEFAULT_FETCH_INTERVAL}',
        access_token TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime')),
        last_login TEXT
      )
    `;

    const createRoomsTableSQL = `
      CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        qq_id TEXT NOT NULL,
        apartment_id TEXT NOT NULL,
        apartment_name TEXT,
        room_uid TEXT NOT NULL,
        room_label TEXT,
        UNIQUE(qq_id, room_uid),
        FOREIGN KEY (qq_id) REFERENCES users(qq_id) ON DELETE CASCADE
      )
    `;

    const createBillingHistoryTableSQL = `
      CREATE TABLE IF NOT EXISTS billing_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        qq_id TEXT NOT NULL,
        room_uid TEXT NOT NULL,
        balance REAL NOT NULL,
        room_label TEXT,
        recorded_at TEXT DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (qq_id) REFERENCES users(qq_id) ON DELETE CASCADE
      )
    `;

    const createNotificationsTableSQL = `
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_type TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        qq_id TEXT NOT NULL,
        hour INTEGER NOT NULL CHECK(hour >= 0 AND hour <= 23),
        threshold REAL,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(chat_type, chat_id, qq_id)
      )
    `;

    const createIndexSQL = `
      CREATE INDEX IF NOT EXISTS idx_users_qq_id ON users(qq_id);
      CREATE INDEX IF NOT EXISTS idx_rooms_qq_id ON rooms(qq_id);
      CREATE INDEX IF NOT EXISTS idx_billing_qq_room ON billing_history(qq_id, room_uid);
      CREATE INDEX IF NOT EXISTS idx_billing_recorded_at ON billing_history(recorded_at);
      CREATE INDEX IF NOT EXISTS idx_chat ON notifications(chat_type, chat_id);
    `;

    this.db.exec(createUsersTableSQL);
    this.db.exec(createRoomsTableSQL);
    this.db.exec(createBillingHistoryTableSQL);
    this.db.exec(createNotificationsTableSQL);
    this.db.exec(createIndexSQL);
  }

  /**
   * Generate a random salt (used for credential encryption)
   */
  private generateSalt(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Add or update a user and their encrypted openId credential
   */
  addUser(qqId: string, openId: string, userId?: string, name?: string): UserPublic {
    const salt = this.generateSalt();
    const encryptedOpenId = encryptionService.encrypt(openId, config.encryptionKey);

    const stmt = this.db.prepare(`
      INSERT INTO users (qq_id, encrypted_openid, salt, user_id, name)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(qq_id) DO UPDATE SET
        encrypted_openid = excluded.encrypted_openid,
        salt = excluded.salt,
        user_id = COALESCE(excluded.user_id, user_id),
        name = COALESCE(excluded.name, name),
        updated_at = datetime('now', 'localtime')
    `);

    stmt.run(qqId, encryptedOpenId, salt, userId ?? null, name ?? null);

    const user = this.getUser(qqId);
    if (!user) {
      throw new Error('Failed to add user');
    }
    return user;
  }

  /**
   * Get user by QQ ID (without credentials)
   */
  getUser(qqId: string): UserPublic | null {
    const stmt = this.db.prepare(`
      SELECT id, qq_id, user_id, name, fetch_interval, created_at, updated_at, last_login
      FROM users
      WHERE qq_id = ?
    `);

    return stmt.get(qqId) as UserPublic | null;
  }

  /**
   * Get the decrypted openId for a user
   */
  getOpenId(qqId: string): string | null {
    const stmt = this.db.prepare(`
      SELECT encrypted_openid, salt FROM users WHERE qq_id = ?
    `);
    const row = stmt.get(qqId) as { encrypted_openid: string } | undefined;
    if (!row) {
      return null;
    }

    try {
      return encryptionService.decrypt(row.encrypted_openid, config.encryptionKey);
    } catch (error) {
      console.error('Failed to decrypt openId:', error);
      return null;
    }
  }

  /**
   * Get the stored access token for a user, if any.
   *
   * The API does not advertise a token lifetime, so the cached token is used
   * until the API rejects it (the caller re-mints in that case).
   */
  getToken(qqId: string): string | null {
    const stmt = this.db.prepare(`
      SELECT access_token FROM users WHERE qq_id = ?
    `);
    const row = stmt.get(qqId) as { access_token: string | null } | undefined;
    return row?.access_token ?? null;
  }

  /**
   * Store the access token for a user
   */
  setToken(qqId: string, token: string): void {
    const stmt = this.db.prepare(`
      UPDATE users
      SET access_token = ?,
          updated_at = datetime('now', 'localtime')
      WHERE qq_id = ?
    `);
    stmt.run(token, qqId);
  }

  /**
   * Clear the stored access token for a user (when it is no longer valid)
   */
  clearToken(qqId: string): void {
    const stmt = this.db.prepare(`
      UPDATE users
      SET access_token = NULL,
          updated_at = datetime('now', 'localtime')
      WHERE qq_id = ?
    `);
    stmt.run(qqId);
  }

  /**
   * Update last login timestamp
   */
  updateLastLogin(qqId: string): void {
    const stmt = this.db.prepare(`
      UPDATE users
      SET last_login = datetime('now', 'localtime')
      WHERE qq_id = ?
    `);
    stmt.run(qqId);
  }

  /**
   * Update fetch interval
   */
  updateFetchInterval(qqId: string, fetchInterval: string): void {
    const stmt = this.db.prepare(`
      UPDATE users
      SET fetch_interval = ?,
          updated_at = datetime('now', 'localtime')
      WHERE qq_id = ?
    `);
    stmt.run(fetchInterval, qqId);
  }

  /**
   * Delete a user (rooms and billing history are removed via CASCADE)
   */
  deleteUser(qqId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM users WHERE qq_id = ?');
    const result = stmt.run(qqId);
    return result.changes > 0;
  }

  /**
   * Get all users (without credentials)
   */
  getAllUsers(): UserPublic[] {
    const stmt = this.db.prepare(`
      SELECT id, qq_id, user_id, name, fetch_interval, created_at, updated_at, last_login
      FROM users
      ORDER BY created_at DESC
    `);
    return stmt.all() as UserPublic[];
  }

  /**
   * Get user count
   */
  getUserCount(): number {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM users').get() as {
      count: number;
    };
    return result.count;
  }

  /**
   * Replace the set of rooms bound to a user
   */
  replaceRooms(qqId: string, rooms: RoomRegistration[]): void {
    const tx = this.db.transaction((userId: string, roomList: RoomRegistration[]) => {
      this.db.prepare('DELETE FROM rooms WHERE qq_id = ?').run(userId);
      const stmt = this.db.prepare(`
        INSERT INTO rooms (qq_id, apartment_id, apartment_name, room_uid, room_label)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const room of roomList) {
        stmt.run(userId, room.apartmentId, room.apartmentName, room.roomUid, room.roomLabel);
      }
    });
    tx(qqId, rooms);
  }

  /**
   * Get all rooms bound to a user
   */
  getRooms(qqId: string): BoundRoom[] {
    const stmt = this.db.prepare(`
      SELECT id, qq_id, apartment_id, apartment_name, room_uid, room_label
      FROM rooms
      WHERE qq_id = ?
      ORDER BY id ASC
    `);
    return stmt.all(qqId) as BoundRoom[];
  }

  /**
   * Get a single bound room
   */
  getRoom(qqId: string, roomUid: string): BoundRoom | null {
    const stmt = this.db.prepare(`
      SELECT id, qq_id, apartment_id, apartment_name, room_uid, room_label
      FROM rooms
      WHERE qq_id = ? AND room_uid = ?
    `);
    return stmt.get(qqId, roomUid) as BoundRoom | null;
  }

  /**
   * Add a billing history record
   */
  addBillingHistory(qqId: string, roomUid: string, balance: number, roomLabel?: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO billing_history (qq_id, room_uid, balance, room_label)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(qqId, roomUid, balance, roomLabel ?? null);
  }

  /**
   * Get billing history for a user (optionally limited to a room and/or last N days)
   */
  getBillingHistory(qqId: string, roomUid?: string, days?: number): BillingRecord[] {
    let sql = `
      SELECT id, qq_id, room_uid, balance, room_label, recorded_at
      FROM billing_history
      WHERE qq_id = ?
    `;
    const params: (string | number)[] = [qqId];

    if (roomUid !== undefined) {
      sql += ' AND room_uid = ?';
      params.push(roomUid);
    }

    if (days !== undefined) {
      sql += ` AND datetime(recorded_at) >= datetime('now', 'localtime', '-' || ? || ' days')`;
      params.push(days);
    }

    sql += ' ORDER BY recorded_at DESC';

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as BillingRecord[];
  }

  /**
   * Get billing history for a user within a specific time range
   */
  getBillingHistoryByTimeRange(
    qqId: string,
    startTime?: Date | null,
    endTime?: Date | null
  ): BillingRecord[] {
    let sql = `
      SELECT id, qq_id, room_uid, balance, room_label, recorded_at
      FROM billing_history
      WHERE qq_id = ?
    `;
    const params: (string | number)[] = [qqId];

    const toLocalTimeString = (date: Date): string => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    };

    if (startTime) {
      sql += ' AND recorded_at >= ?';
      params.push(toLocalTimeString(startTime));
    }

    if (endTime) {
      sql += ' AND recorded_at <= ?';
      params.push(toLocalTimeString(endTime));
    }

    sql += ' ORDER BY recorded_at DESC';

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as BillingRecord[];
  }

  /**
   * Get the latest billing record for a room
   */
  getLatestBilling(qqId: string, roomUid: string): BillingRecord | null {
    const stmt = this.db.prepare(`
      SELECT id, qq_id, room_uid, balance, room_label, recorded_at
      FROM billing_history
      WHERE qq_id = ? AND room_uid = ?
      ORDER BY recorded_at DESC
      LIMIT 1
    `);
    return stmt.get(qqId, roomUid) as BillingRecord | null;
  }

  /**
   * Get the balance change over the last 24 hours for a room.
   * Falls back to the earliest known record if none exists from 24h ago.
   */
  getBalance24hChange(qqId: string, roomUid: string): BalanceChange | null {
    const currentRecord = this.getLatestBilling(qqId, roomUid);
    if (!currentRecord) {
      return null;
    }

    const prevStmt = this.db.prepare(`
      SELECT balance FROM billing_history
      WHERE qq_id = ? AND room_uid = ?
        AND datetime(recorded_at) <= datetime('now', 'localtime', '-1 day')
      ORDER BY recorded_at DESC
      LIMIT 1
    `);
    let prevRecord = prevStmt.get(qqId, roomUid) as { balance: number } | undefined;

    if (!prevRecord) {
      const firstStmt = this.db.prepare(`
        SELECT balance FROM billing_history
        WHERE qq_id = ? AND room_uid = ?
        ORDER BY recorded_at ASC
        LIMIT 1
      `);
      prevRecord = firstStmt.get(qqId, roomUid) as { balance: number } | undefined;
    }

    const prevBalance = prevRecord ? prevRecord.balance : currentRecord.balance;
    return { balance: currentRecord.balance - prevBalance };
  }

  /**
   * Delete old billing history records (keep last N days)
   */
  cleanOldBillingHistory(days: number = 30): number {
    const stmt = this.db.prepare(`
      DELETE FROM billing_history
      WHERE datetime(recorded_at) < datetime('now', 'localtime', '-' || ? || ' days')
    `);
    const result = stmt.run(days);
    return result.changes;
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }

  /**
   * Backup database
   */
  backup(backupPath: string): void {
    this.db.backup(backupPath);
  }

  /**
   * Get the underlying database instance
   */
  getDatabase(): Database.Database {
    return this.db;
  }
}

// Export singleton instance
export const db = new UserDatabase();

// Create and export scheduler instance using the same database
export const scheduler = new NotificationScheduler(db.getDatabase());

// Export class for testing or custom instances
export { UserDatabase };
