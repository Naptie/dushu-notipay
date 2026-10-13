export interface RoomBalanceView {
  roomLabel: string;
  balance: number;
  change24h?: number | null;
}

/**
 * Generate the text summary of room balances with optional 24h changes.
 */
export const generateBalanceSummary = (rooms: RoomBalanceView[]): string => {
  const blocks = rooms.map((room) => {
    let output = `🏠 ${room.roomLabel}\n`;
    output += '📊 当前余额\n';
    output += '─'.repeat(15) + '\n';
    output += `💰 余额：\t${room.balance.toFixed(2)} 元\n`;

    if (room.change24h !== null && room.change24h !== undefined) {
      output += '\n📈 最近 24 小时\n';
      output += '─'.repeat(15) + '\n';
      const change = room.change24h;
      output += `💰 余额：\t${change > 0 ? '+' : ''}${change.toFixed(2)} 元\n`;
    }

    return output;
  });

  return blocks.join('\n');
};
