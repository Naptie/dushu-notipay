/**
 * Time parsing and scheduling helpers shared by the bot and the CLI tools.
 * All user-facing times are interpreted in the server's local timezone (UTC+8).
 */

/**
 * Parse a relative time string and return the duration in hours
 * Supports formats like:
 * - "7h" (7 hours)
 * - "3d" (3 days)
 * - "2w" (2 weeks)
 */
export const parseRelativeTime = (param: string): number => {
  const cleanParam = param.replace(/[^0-9a-zA-Z]/g, '');
  const unitMatch = cleanParam.match(/^(\d+)([hdw])$/i);

  if (unitMatch) {
    const value = parseInt(unitMatch[1], 10);
    const unit = unitMatch[2].toLowerCase();

    if (unit === 'h') {
      return value;
    } else if (unit === 'd') {
      return value * 24;
    } else if (unit === 'w') {
      return value * 24 * 7;
    }
  }

  throw new Error('Invalid relative time format');
};

/**
 * Calculate the next fetch time based on last login or creation time and interval
 */
export const calculateNextFetchTime = (
  lastLogin: string | undefined,
  createdAt: string,
  intervalHours: number
): Date => {
  let baseTime: Date;
  if (lastLogin) {
    // If fetched before, use last fetch time rounded to nearest hour
    baseTime = new Date(lastLogin);
  } else {
    // If never fetched, use creation time rounded to nearest hour
    baseTime = new Date(createdAt);
  }
  if (baseTime.getMinutes() >= 30) {
    baseTime.setHours(baseTime.getHours() + 1);
  }
  baseTime.setMinutes(0, 0, 0);

  return new Date(baseTime.getTime() + intervalHours * 60 * 60 * 1000);
};

/**
 * Parse a time parameter from user input (using local time UTC+8)
 * Supports formats like:
 * - "7h" (7 hours ago)
 * - "3d" (3 days ago)
 * - "2w" (2 weeks ago)
 * - "1030" (Oct 30 00:00)
 * - "10302330" (Oct 30 23:30)
 * - "10-30|23:30" (with delimiters)
 */
export const parseTimeParameter = (param: string): Date => {
  const now = new Date();

  // Try to parse as relative time first
  try {
    const hours = parseRelativeTime(param);
    const result = new Date(now);
    result.setHours(result.getHours() - hours);
    return result;
  } catch {
    // Not a relative time format, continue to other formats
  }

  // Check for delimiters (-, /, :, |, space) to parse as date/time
  const hasDelimiters = /[-/:|\s]/.test(param);

  if (hasDelimiters) {
    // Split by delimiters and extract numbers
    const parts = param.split(/[-/:|\s]+/).filter((p) => p.trim());

    if (parts.length < 2) {
      throw new Error('日期格式不正确，需要至少包含月份和日期');
    }

    // Parse as: month day [hour] [minute]
    const month = parseInt(parts[0], 10);
    const day = parseInt(parts[1], 10);
    const hour = parts.length > 2 ? parseInt(parts[2], 10) : 0;
    const minute = parts.length > 3 ? parseInt(parts[3], 10) : 0;

    if (isNaN(month) || isNaN(day) || month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error('日期格式不正确');
    }

    if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error('时间格式不正确');
    }

    const result = new Date(now.getFullYear(), month - 1, day, hour, minute, 0, 0);

    // If the parsed date is in the future, assume it's from last year
    if (result > now) {
      result.setFullYear(result.getFullYear() - 1);
    }

    return result;
  }

  // Parse as continuous digits (e.g., "1030" or "10302330")
  const digitsOnly = param.replace(/[^0-9a-zA-Z]/g, '');

  if (digitsOnly.length < 4) {
    // Less than 4 digits, treat as hours with default unit
    const hours = parseInt(digitsOnly, 10);
    if (isNaN(hours)) {
      throw new Error('时间参数格式不正确');
    }
    const result = new Date(now);
    result.setHours(result.getHours() - hours);
    return result;
  }

  // 4 or more digits: parse as MMDD or MMDDHHMM
  const month = parseInt(digitsOnly.substring(0, 2), 10);
  const day = parseInt(digitsOnly.substring(2, 4), 10);

  let hour = 0;
  let minute = 0;

  if (digitsOnly.length >= 6) {
    hour = parseInt(digitsOnly.substring(4, 6), 10);
  }
  if (digitsOnly.length >= 8) {
    minute = parseInt(digitsOnly.substring(6, 8), 10);
  }

  if (isNaN(month) || isNaN(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error('日期格式不正确');
  }

  if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('时间格式不正确');
  }

  const result = new Date(now.getFullYear(), month - 1, day, hour, minute, 0, 0);

  if (result > now) {
    result.setFullYear(result.getFullYear() - 1);
  }

  return result;
};

/**
 * Format a Date as "M月D日 HH:mm" in the local timezone
 */
export const formatLocalShort = (date: Date): string => {
  return `${date.getMonth() + 1}月${date.getDate()}日 ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
};

/**
 * Round a Date up to the next top of the hour (as the scheduler would interpret it)
 */
export const roundUpToNextHour = (date: Date): Date => {
  const result = new Date(date);
  if (result.getMinutes() > 0 || result.getSeconds() > 0 || result.getMilliseconds() > 0) {
    result.setHours(result.getHours() + 1);
  }
  result.setMinutes(0, 0, 0);
  return result;
};
